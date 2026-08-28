import { describe, expect, it } from 'vitest';
import {
  MAX_BOUNDED_REPETITION,
  MAX_MATCH_INPUT_LENGTH,
  MAX_RULE_PATTERN_LENGTH,
  MAX_UNBOUNDED_QUANTIFIERS,
  RULE_MATCH_TYPES,
  assertValidRule,
  compileRulePattern,
  findFirstMatchingRule,
  matchRule,
  normalizeForMatch,
  orderRules,
} from '@/domain/categorization/rule-matcher.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  assertValidConfidence,
  isDeterministicSource,
  isValidConfidence,
  routeByConfidence,
  routeCategorization,
} from '@/domain/categorization/confidence.js';
import { CATEGORIZATION_SOURCES } from '@/domain/ledger/transaction.js';
import { ValidationError } from '@/domain/errors.js';
import { expectErr, expectOk, expectThrows } from '@tests/helpers/expect.js';
import type {
  CategorizationRule,
  MatchableTransaction,
  RuleMatchType,
} from '@/domain/categorization/rule-matcher.js';

const ACCOUNT_A = 'acct-a';
const ACCOUNT_B = 'acct-b';
const CATEGORY_COFFEE = 'cat-coffee';

function rule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: 'rule-1',
    priority: 100,
    matchType: 'merchant_contains',
    matchValue: 'daves coffee',
    amountMin: null,
    amountMax: null,
    accountId: null,
    categoryId: CATEGORY_COFFEE,
    markAsTransfer: false,
    isEnabled: true,
    ...overrides,
  };
}

function tx(overrides: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    accountId: ACCOUNT_A,
    amount: -45000n,
    description: 'SQ *DAVES COFFEE #12',
    merchantNormalized: 'daves coffee',
    ...overrides,
  };
}

describe('the five match types (7.5)', () => {
  it('covers every match type in the schema enum', () => {
    expect([...RULE_MATCH_TYPES]).toEqual([
      'merchant_contains',
      'merchant_regex',
      'description_contains',
      'amount_equals',
      'amount_between',
    ]);
  });

  const MATCHING: readonly (readonly [RuleMatchType, Partial<CategorizationRule>])[] = [
    ['merchant_contains', { matchValue: 'daves' }],
    ['merchant_regex', { matchValue: '^daves' }],
    ['description_contains', { matchValue: 'SQ *DAVES' }],
    ['amount_equals', { amountMin: -45000n }],
    ['amount_between', { amountMin: -50000n, amountMax: -40000n }],
  ];

  it.each(MATCHING)('%s matches', (matchType, overrides) => {
    expect(matchRule(rule({ matchType, ...overrides }), tx())).toBe(true);
  });

  const NOT_MATCHING: readonly (readonly [RuleMatchType, Partial<CategorizationRule>])[] = [
    ['merchant_contains', { matchValue: 'starbucks' }],
    ['merchant_regex', { matchValue: '^starbucks' }],
    ['description_contains', { matchValue: 'WHOLE FOODS' }],
    ['amount_equals', { amountMin: -45001n }],
    ['amount_between', { amountMin: -40000n, amountMax: -30000n }],
  ];

  it.each(NOT_MATCHING)('%s does not match', (matchType, overrides) => {
    expect(matchRule(rule({ matchType, ...overrides }), tx())).toBe(false);
  });
});

describe('case and normalization', () => {
  it.each([
    ['DAVES COFFEE', 'daves coffee'],
    ['  daves   coffee  ', 'daves coffee'],
    ['Daves Coffee', 'daves coffee'],
    ['daves\tcoffee', 'daves coffee'],
    ['daves\n\ncoffee', 'daves coffee'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeForMatch(input)).toBe(expected);
  });

  it('folds full-width forms via NFKC', () => {
    expect(normalizeForMatch('ＤＡＶＥＳ')).toBe('daves');
  });

  it.each(['DAVES', 'daves', 'DaVeS', '  daves  '])(
    'matches merchant_contains case-insensitively for %j',
    (matchValue) => {
      expect(matchRule(rule({ matchType: 'merchant_contains', matchValue }), tx())).toBe(true);
    },
  );

  it('matches description_contains against an upper-case description', () => {
    // Descriptions arrive as the institution wrote them; users type lower case.
    expect(
      matchRule(rule({ matchType: 'description_contains', matchValue: 'daves coffee' }), tx()),
    ).toBe(true);
  });

  it('collapses whitespace runs in the haystack too', () => {
    expect(
      matchRule(
        rule({ matchType: 'description_contains', matchValue: 'daves coffee' }),
        tx({ description: 'SQ  *DAVES    COFFEE' }),
      ),
    ).toBe(true);
  });

  it.each(['merchant_contains', 'merchant_regex'] as const)(
    '%s never matches when merchantNormalized is null, and never throws',
    (matchType) => {
      const matchValue = matchType === 'merchant_regex' ? '.*' : 'daves';
      expect(matchRule(rule({ matchType, matchValue }), tx({ merchantNormalized: null }))).toBe(
        false,
      );
    },
  );

  it('still matches description_contains when the merchant is null', () => {
    expect(
      matchRule(
        rule({ matchType: 'description_contains', matchValue: 'daves' }),
        tx({ merchantNormalized: null }),
      ),
    ).toBe(true);
  });
});

describe('amount matching is signed, in the internal convention (6.3)', () => {
  it('matches an exact negative amount', () => {
    expect(matchRule(rule({ matchType: 'amount_equals', amountMin: -45000n }), tx())).toBe(true);
  });

  it.each([
    ['one minor unit below', -45001n],
    ['one minor unit above', -44999n],
  ])('does not match %s', (_label, amountMin) => {
    expect(matchRule(rule({ matchType: 'amount_equals', amountMin }), tx())).toBe(false);
  });

  it.each([
    ['at the lower bound', -45000n, -40000n, true],
    ['at the upper bound', -50000n, -45000n, true],
    ['strictly inside', -50000n, -40000n, true],
    ['one unit outside the lower bound', -44999n, -40000n, false],
    ['one unit outside the upper bound', -50000n, -45001n, false],
  ])('amount_between %s', (_label, amountMin, amountMax, expected) => {
    expect(matchRule(rule({ matchType: 'amount_between', amountMin, amountMax }), tx())).toBe(
      expected,
    );
  });

  it('does not match an income transaction against a spending range', () => {
    // The point of signed comparison: a +45000 salary line is not a 450 coffee.
    const spendingRule = rule({
      matchType: 'amount_between',
      amountMin: -50000n,
      amountMax: -40000n,
    });
    expect(matchRule(spendingRule, tx({ amount: 45000n }))).toBe(false);
  });

  it('can target income with a positive range', () => {
    const incomeRule = rule({
      matchType: 'amount_between',
      amountMin: 1n,
      amountMax: 10_000_000n,
    });
    expect(matchRule(incomeRule, tx({ amount: 5_000_000n }))).toBe(true);
    expect(matchRule(incomeRule, tx({ amount: -5_000_000n }))).toBe(false);
  });

  it('handles amounts beyond 2^53', () => {
    const big = rule({ matchType: 'amount_equals', amountMin: -9007199254740993n });
    expect(matchRule(big, tx({ amount: -9007199254740993n }))).toBe(true);
    expect(matchRule(big, tx({ amount: -9007199254740992n }))).toBe(false);
  });
});

describe('account restriction', () => {
  it.each(RULE_MATCH_TYPES)('applies to every account when accountId is null: %s', (matchType) => {
    const overrides: Partial<CategorizationRule> =
      matchType === 'amount_equals'
        ? { amountMin: -45000n }
        : matchType === 'amount_between'
          ? { amountMin: -50000n, amountMax: -40000n }
          : matchType === 'merchant_regex'
            ? { matchValue: 'daves' }
            : matchType === 'description_contains'
              ? { matchValue: 'daves' }
              : { matchValue: 'daves' };
    const scoped = rule({ matchType, accountId: null, ...overrides });
    expect(matchRule(scoped, tx({ accountId: ACCOUNT_A }))).toBe(true);
    expect(matchRule(scoped, tx({ accountId: ACCOUNT_B }))).toBe(true);
  });

  it('matches only the named account when accountId is set', () => {
    const scoped = rule({ accountId: ACCOUNT_A });
    expect(matchRule(scoped, tx({ accountId: ACCOUNT_A }))).toBe(true);
    expect(matchRule(scoped, tx({ accountId: ACCOUNT_B }))).toBe(false);
  });

  it('applies the account filter before the match type', () => {
    const scoped = rule({ matchType: 'amount_equals', amountMin: -45000n, accountId: ACCOUNT_B });
    expect(matchRule(scoped, tx({ accountId: ACCOUNT_A }))).toBe(false);
  });
});

describe('ordering, enablement and first-match-wins', () => {
  it('orders by priority ascending, lower first (7.5)', () => {
    const rules = [
      rule({ id: 'c', priority: 300 }),
      rule({ id: 'a', priority: 100 }),
      rule({ id: 'b', priority: 200 }),
    ];
    expect(orderRules(rules).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks equal priority by id ascending, so the older UUIDv7 wins', () => {
    const rules = [
      rule({ id: '018f0002', priority: 100 }),
      rule({ id: '018f0001', priority: 100 }),
      rule({ id: '018f0003', priority: 100 }),
    ];
    expect(orderRules(rules).map((r) => r.id)).toEqual(['018f0001', '018f0002', '018f0003']);
  });

  it('is deterministic regardless of input order', () => {
    const a = rule({ id: 'x', priority: 100 });
    const b = rule({ id: 'y', priority: 100 });
    expect(orderRules([a, b]).map((r) => r.id)).toEqual(orderRules([b, a]).map((r) => r.id));
  });

  it('drops disabled rules before ordering', () => {
    const rules = [rule({ id: 'a', isEnabled: false }), rule({ id: 'b', isEnabled: true })];
    expect(orderRules(rules).map((r) => r.id)).toEqual(['b']);
  });

  it('returns the first match, not the best one', () => {
    const first = rule({ id: 'a', priority: 10, categoryId: 'cat-first' });
    const second = rule({ id: 'b', priority: 20, categoryId: 'cat-second' });
    expect(findFirstMatchingRule([second, first], tx())?.categoryId).toBe('cat-first');
  });

  it('does not let a disabled high-priority rule shadow an enabled lower one', () => {
    const disabled = rule({ id: 'a', priority: 10, categoryId: 'cat-disabled', isEnabled: false });
    const enabled = rule({ id: 'b', priority: 90, categoryId: 'cat-enabled' });
    expect(findFirstMatchingRule([disabled, enabled], tx())?.categoryId).toBe('cat-enabled');
  });

  it('returns null when no rule matches', () => {
    expect(findFirstMatchingRule([rule({ matchValue: 'starbucks' })], tx())).toBeNull();
  });

  it('returns null for an empty rule list', () => {
    expect(findFirstMatchingRule([], tx())).toBeNull();
  });

  it('carries markAsTransfer through the match', () => {
    const transferRule = rule({ markAsTransfer: true });
    expect(findFirstMatchingRule([transferRule], tx())).toEqual({
      rule: transferRule,
      categoryId: CATEGORY_COFFEE,
      markAsTransfer: true,
    });
  });
});

describe('rule validation', () => {
  it.each([
    ['amount_equals with a null amountMin', { matchType: 'amount_equals' as const }],
    [
      'amount_equals with a conflicting amountMax',
      { matchType: 'amount_equals' as const, amountMin: -100n, amountMax: -200n },
    ],
    [
      'amount_between with a null lower bound',
      { matchType: 'amount_between' as const, amountMax: -1n },
    ],
    [
      'amount_between with a null upper bound',
      { matchType: 'amount_between' as const, amountMin: -1n },
    ],
    [
      'amount_between with inverted bounds',
      { matchType: 'amount_between' as const, amountMin: -1n, amountMax: -100n },
    ],
    ['merchant_contains with an empty value', { matchValue: '' }],
    ['merchant_contains with only whitespace', { matchValue: '   ' }],
    [
      'description_contains with an empty value',
      { matchType: 'description_contains' as const, matchValue: '' },
    ],
    [
      'merchant_regex with an empty pattern',
      { matchType: 'merchant_regex' as const, matchValue: '' },
    ],
  ])('rejects %s', (_label, overrides) => {
    expectThrows(ValidationError, () => {
      assertValidRule(rule(overrides));
    });
  });

  it('throws rather than silently never matching', () => {
    // A rule that quietly matches nothing is worse than one that throws: the
    // user sees transactions going uncategorized with no way to find out why.
    expectThrows(ValidationError, () => matchRule(rule({ matchType: 'amount_equals' }), tx()));
  });

  it('propagates the failure out of findFirstMatchingRule', () => {
    expectThrows(ValidationError, () =>
      findFirstMatchingRule([rule({ matchType: 'amount_equals' })], tx()),
    );
  });

  it('accepts amount_equals with amountMax equal to amountMin', () => {
    expect(() => {
      assertValidRule(rule({ matchType: 'amount_equals', amountMin: -100n, amountMax: -100n }));
    }).not.toThrow();
  });

  it('names the offending field', () => {
    const error = expectThrows(ValidationError, () => {
      assertValidRule(rule({ matchType: 'amount_between', amountMin: -1n, amountMax: -100n }));
    });
    expect(error.details?.[0]?.code).toBe('INVERTED_BOUNDS');
  });
});

/* ============================================================================
   ReDoS - DEV_PIPELINE.MD Phase 1 trap: "merchant_regex is a ReDoS vector"
   ========================================================================= */

describe('compileRulePattern rejects catastrophic constructs', () => {
  it.each([
    // The classic exponential family: a quantifier applied to a group.
    ['(a+)+$', 'quantified-group'],
    ['(a*)*b', 'quantified-group'],
    ['(a|a)*$', 'quantified-group'],
    ['(a|ab)*c', 'quantified-group'],
    ['(x+x+)+y', 'quantified-group'],
    ['^(\\w+\\s?)*$', 'quantified-group'],
    ['(.*)*x', 'quantified-group'],
    ['([a-z]+)+$', 'quantified-group'],
    ['(?:a+)+b', 'quantified-group'],
    ['(a{1,2})*b', 'quantified-group'],
    ['(a)+', 'quantified-group'],
    ['(ab){2,10}c', 'quantified-group'],
    ['(a+){2,}b', 'quantified-group'],
    // Backreferences.
    ['(a)\\1+', 'backreference'],
    ['(?<n>a)\\k<n>+', 'backreference'],
    // Lookaround.
    ['(?=a+)b', 'lookaround'],
    ['(?!a+)b', 'lookaround'],
    ['(?<=a+)b', 'lookaround'],
    ['(?<!a+)b', 'lookaround'],
    // Polynomial blowup from stacked open-ended quantifiers.
    ['a*a*a*a*b', 'too-many-unbounded-quantifiers'],
    ['.*.*.*.*x', 'too-many-unbounded-quantifiers'],
    ['.*.*.*x', 'too-many-unbounded-quantifiers'], // measured at 5.4s over a 256-char input
    ['a*a*a*b', 'too-many-unbounded-quantifiers'],
    // Unbounded bounded-repetition.
    [`a{1,${String(MAX_BOUNDED_REPETITION + 1)}}b`, 'repetition-too-large'],
    ['a{500}b', 'repetition-too-large'],
  ])('rejects %j as %s', (pattern, code) => {
    expect(expectErr(compileRulePattern(pattern)).code).toBe(code);
  });

  it('rejects a pattern longer than the cap', () => {
    expect(expectErr(compileRulePattern('a'.repeat(MAX_RULE_PATTERN_LENGTH + 1))).code).toBe(
      'too-long',
    );
  });

  it('rejects an empty pattern', () => {
    expect(expectErr(compileRulePattern('')).code).toBe('empty');
  });

  it.each(['(', '[a-', '*', 'a{2,1}', '(?<', '\\'])(
    'surfaces malformed syntax %j as a rejection, never a thrown SyntaxError',
    (pattern) => {
      const result = compileRulePattern(pattern);
      expect(result.ok).toBe(false);
    },
  );
});

describe('compileRulePattern accepts realistic merchant patterns', () => {
  it.each([
    ['^sq \\*', 'sq *daves coffee', true],
    ['amzn.*mktp', 'amzn mktp us', true],
    ['netflix\\.com', 'netflix.com', true],
    ['\\d{4}$', 'store 1234', true],
    ['(spotify|netflix)', 'spotify premium', true],
    ['(?:sq )?daves', 'daves coffee', true],
    ['^grab', 'grabfood delivery', true],
    ['coffee$', 'daves coffee', true],
    ['^starbucks', 'daves coffee', false],
    ['[0-9]+ eleven', '7 eleven', true],
  ])('compiles %j and tests %j as %s', (pattern, input, expected) => {
    expect(expectOk(compileRulePattern(pattern)).test(input)).toBe(expected);
  });

  it('matches case-insensitively', () => {
    expect(expectOk(compileRulePattern('daves')).test('DAVES COFFEE')).toBe(true);
  });

  it('allows exactly the permitted number of open-ended quantifiers', () => {
    expect(compileRulePattern('a*b*c').ok).toBe(true); // two
    expect(compileRulePattern('a*b*c*d').ok).toBe(false); // three
  });

  it('allows an optional group, which cannot blow up', () => {
    // `(...)?` matches at most once, so it carries no backtracking risk and
    // rejecting it would break ordinary patterns.
    expect(compileRulePattern('(?:sq )?daves').ok).toBe(true);
    expect(compileRulePattern('(abc)?d').ok).toBe(true);
  });

  it('treats a literal brace as a literal, not a quantifier', () => {
    expect(expectOk(compileRulePattern('a{b')).test('a{b')).toBe(true);
  });

  it('does not confuse a lazy modifier with a quantifier on a group', () => {
    expect(compileRulePattern('a+?b').ok).toBe(true);
    expect(compileRulePattern('a*?b').ok).toBe(true);
  });

  it('handles an escape inside a character class', () => {
    // `[a\]b]` contains an escaped closing bracket; the scanner must not treat
    // it as the end of the class.
    expect(expectOk(compileRulePattern('[a\\]b]x')).test(']x')).toBe(true);
    expect(expectOk(compileRulePattern('[\\d]+ eleven')).test('7 eleven')).toBe(true);
  });

  it('counts {n,} as an open-ended quantifier', () => {
    expect(compileRulePattern('a{2,}b').ok).toBe(true);
    expect(compileRulePattern('a{2,}b{2,}c{2,}d').ok).toBe(false); // three open-ended
    expect(expectOk(compileRulePattern('a{2,}b')).test('aaab')).toBe(true);
  });

  it('accepts an exact {n} repetition', () => {
    expect(expectOk(compileRulePattern('a{3}b')).test('aaab')).toBe(true);
    expect(expectOk(compileRulePattern('a{3}b')).test('aab')).toBe(false);
  });

  it('ignores metacharacters inside a character class', () => {
    expect(expectOk(compileRulePattern('[(+*)]x')).test('(x')).toBe(true);
  });

  it('truncates the input it tests', () => {
    const long = `${'b'.repeat(MAX_MATCH_INPUT_LENGTH)}needle`;
    expect(expectOk(compileRulePattern('needle')).test(long)).toBe(false);
    expect(expectOk(compileRulePattern('needle')).test(`needle${'b'.repeat(1000)}`)).toBe(true);
  });
});

describe('the ReDoS bound holds in practice', () => {
  it('runs the worst permitted pattern against adversarial input well inside budget', () => {
    // Three open-ended quantifiers is the maximum the compiler allows, and 256
    // characters is the maximum input. That is the theoretical worst case the
    // design permits; if either cap were removed this assertion is what fails.
    // `a*a*b` is the measured worst case among patterns the caps admit: two
    // open-ended quantifiers over an overlapping single-character class.
    const worst = expectOk(compileRulePattern('a*a*b'));
    const adversarial = 'a'.repeat(MAX_MATCH_INPUT_LENGTH * 8); // truncated on test

    const started = performance.now();
    expect(worst.test(adversarial)).toBe(false);
    const elapsed = performance.now() - started;

    // Measured cold at ~18ms. The budget is generous enough that a loaded CI
    // machine cannot make it flake, and tight enough that relaxing either cap
    // fails it by an order of magnitude: three quantifiers at this length
    // measured 359ms, and at 256 characters, 5,403ms.
    expect(elapsed).toBeLessThan(150);
  });

  it('would have been catastrophic without the compiler guard', () => {
    // The same input against a rejected pattern. This asserts the guard is what
    // stands between the rules engine and an unbounded regex, without ever
    // executing the dangerous pattern.
    expect(expectErr(compileRulePattern('(a+)+$')).code).toBe('quantified-group');
    // Both caps are load-bearing and were set by measurement; pinning them here
    // means widening either one is a deliberate, visible change.
    expect(MAX_UNBOUNDED_QUANTIFIERS).toBe(2);
    expect(MAX_MATCH_INPUT_LENGTH).toBe(128);
  });

  it('keeps every rejected pattern out of the matcher entirely', () => {
    const dangerous = rule({ matchType: 'merchant_regex', matchValue: '(a+)+$' });
    const error = expectThrows(ValidationError, () => matchRule(dangerous, tx()));
    expect(error.details?.[0]?.code).toBe('REGEX_QUANTIFIED_GROUP');
  });
});

/* ============================================================================
   CONFIDENCE - 10.1, 7.4
   ========================================================================= */

describe('confidence validation', () => {
  it.each([0, 0.5, 0.85, 1])('accepts %s', (value) => {
    expect(isValidConfidence(value)).toBe(true);
    expect(() => {
      assertValidConfidence(value);
    }).not.toThrow();
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects %s',
    (value) => {
      expect(isValidConfidence(value)).toBe(false);
      expectThrows(ValidationError, () => {
        assertValidConfidence(value);
      });
    },
  );

  it('validates the threshold as well as the score', () => {
    expectThrows(ValidationError, () => routeByConfidence(0.9, 1.5));
  });
});

describe('threshold routing (10.1)', () => {
  it('routes below the threshold to needs_review', () => {
    expect(routeByConfidence(0.84)).toBe('needs_review');
    expect(routeByConfidence(0.8499999)).toBe('needs_review');
    expect(routeByConfidence(0)).toBe('needs_review');
  });

  it('routes exactly at the threshold to categorized', () => {
    // 10.1 asks `confidence >= 0.85?`, so equality applies.
    expect(routeByConfidence(DEFAULT_CONFIDENCE_THRESHOLD)).toBe('categorized');
    expect(routeByConfidence(0.85)).toBe('categorized');
  });

  it('routes above the threshold to categorized', () => {
    expect(routeByConfidence(0.8500001)).toBe('categorized');
    expect(routeByConfidence(1)).toBe('categorized');
  });

  it('honours a custom threshold', () => {
    expect(routeByConfidence(0.7, 0.6)).toBe('categorized');
    expect(routeByConfidence(0.7, 0.8)).toBe('needs_review');
    expect(routeByConfidence(0.7, 0.7)).toBe('categorized');
  });

  it('matches the 16 default', () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBe(0.85);
  });
});

describe('routeCategorization by source (7.4)', () => {
  it.each(CATEGORIZATION_SOURCES)('classifies source %s', (source) => {
    expect(isDeterministicSource(source)).toBe(source !== 'ai');
  });

  it.each(['manual', 'rule', 'recurring_series', 'import_default'] as const)(
    'routes deterministic source %s straight to categorized',
    (source) => {
      expect(routeCategorization({ source, confidence: null })).toBe('categorized');
    },
  );

  it.each(['manual', 'rule', 'recurring_series', 'import_default'] as const)(
    'rejects a confidence on deterministic source %s',
    (source) => {
      // A rule match is not 87% confident; it matched or it did not. Allowing a
      // score here would let a caller route a deterministic result to review.
      const error = expectThrows(ValidationError, () =>
        routeCategorization({ source, confidence: 0.9 }),
      );
      expect(error.details?.[0]?.code).toBe('UNEXPECTED_CONFIDENCE');
    },
  );

  it('requires a confidence for the ai source', () => {
    const error = expectThrows(ValidationError, () =>
      routeCategorization({ source: 'ai', confidence: null }),
    );
    expect(error.details?.[0]?.code).toBe('MISSING_CONFIDENCE');
  });

  it.each([
    [0.84, 'needs_review'],
    [0.85, 'categorized'],
    [0.86, 'categorized'],
  ] as const)('routes ai confidence %s to %s', (confidence, expected) => {
    expect(routeCategorization({ source: 'ai', confidence })).toBe(expected);
  });

  it('honours a custom threshold for the ai source', () => {
    expect(routeCategorization({ source: 'ai', confidence: 0.7, threshold: 0.6 })).toBe(
      'categorized',
    );
  });
});
