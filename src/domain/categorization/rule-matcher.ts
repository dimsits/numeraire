/**
 * Deterministic rule matching — ARCHITECTURE.MD §7.5, §10.1, ADR-005.
 *
 * The rules tier is the reason the AI stays cheap: "a deterministic cascade
 * runs first; only the residue reaches the model" (ADR-005). Everything here is
 * pure and total, so the tier is fully unit-testable in a way model output
 * never is.
 *
 * ## Amounts are compared **signed**, in the internal convention
 *
 * `tx.amount` is negative for spending (§6.3), and `amountMin` / `amountMax`
 * are stored in that same convention. There is no hidden `abs()`. A rule for
 * "coffee under 200" stores `amountMin: -20000n, amountMax: -1n`; the UI does
 * that conversion, not this module. Comparing magnitudes instead would make
 * `amount_between(-100, 100)` meaningless and would leave a rule unable to
 * distinguish a 450 refund from a 450 charge.
 *
 * ## `merchant_regex` is user input, and therefore a ReDoS vector
 *
 * See `compileRulePattern`.
 */
import { ValidationError } from '@/domain/errors.js';
import { toJsonMinor } from '@/domain/money/money.js';
import { err, ok } from '@/lib/result.js';
import type { Minor } from '@/domain/money/money.js';
import type { Result } from '@/lib/result.js';

/** §7.5 `rule_match_type`. */
export const RULE_MATCH_TYPES = [
  'merchant_contains',
  'merchant_regex',
  'description_contains',
  'amount_equals',
  'amount_between',
] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export interface CategorizationRule {
  readonly id: string;
  /** Lower runs first (§7.5). */
  readonly priority: number;
  readonly matchType: RuleMatchType;
  readonly matchValue: string;
  /** Exact value for `amount_equals`; lower bound for `amount_between`. */
  readonly amountMin: Minor | null;
  /** Upper bound for `amount_between`. */
  readonly amountMax: Minor | null;
  /** `null` applies the rule to every account. */
  readonly accountId: string | null;
  readonly categoryId: string;
  readonly markAsTransfer: boolean;
  readonly isEnabled: boolean;
}

export interface MatchableTransaction {
  readonly accountId: string;
  /** Normalized to the internal convention (§6.3): negative is spending. */
  readonly amount: Minor;
  /** As received from the institution. */
  readonly description: string;
  /** Cleaned merchant string, or `null` when normalization produced nothing. */
  readonly merchantNormalized: string | null;
}

export interface RuleMatch {
  readonly rule: CategorizationRule;
  readonly categoryId: string;
  readonly markAsTransfer: boolean;
}

/* ── ReDoS-safe pattern compilation ──────────────────────────────────────── */

/** Longest accepted `merchant_regex` source. */
export const MAX_RULE_PATTERN_LENGTH = 200;
/**
 * Longest string a compiled pattern will be run against.
 *
 * Cost grows super-linearly in this number, so it is the single most effective
 * control here. Measured, cold, with the worst permitted pattern shape:
 * n=1024 took 42.5s, n=256 took 81ms, n=128 took 11ms. 128 is comfortably
 * larger than any normalized merchant string (7.4: `daves coffee`), which is
 * the only thing `merchant_regex` is ever run against.
 */
export const MAX_MATCH_INPUT_LENGTH = 128;
/**
 * `*`, `+` and `{n,}` are open-ended; each one multiplies the search space.
 *
 * Two, not three. Measured cold at n=256: two quantifiers cost 81ms, three cost
 * **5,403ms**; at n=128, three still cost 359ms. An earlier revision of this
 * module allowed three on the theory that the worst case was "single-digit
 * milliseconds" - the timing test below disproved that, which is why the number
 * is now derived from measurement rather than from arithmetic.
 */
export const MAX_UNBOUNDED_QUANTIFIERS = 2;
/** Largest accepted `{n,m}` bound. */
export const MAX_BOUNDED_REPETITION = 64;

export type RegexRejectionCode =
  | 'empty'
  | 'too-long'
  | 'quantified-group'
  | 'backreference'
  | 'lookaround'
  | 'too-many-unbounded-quantifiers'
  | 'repetition-too-large'
  | 'invalid-syntax';

export interface RegexRejection {
  readonly code: RegexRejectionCode;
  readonly message: string;
}

export interface SafeRulePattern {
  readonly source: string;
  /** Tests `value`, truncated to `MAX_MATCH_INPUT_LENGTH`. */
  test(value: string): boolean;
}

function rejectRegex(code: RegexRejectionCode, message: string): Result<never, RegexRejection> {
  return err({ code, message });
}

/** Matches `{n}`, `{n,}` or `{n,m}` at a position. */
const REPETITION_PATTERN = /^\{(\d+)(?:,(\d*))?\}/;

/**
 * Compile a user-supplied `merchant_regex` into something that cannot blow up.
 *
 * **The constraint that shapes this.** `src/domain` may not import an npm
 * package (dependency-cruiser `domain-no-npm`), so there is no `re2` and no
 * linear-time engine available. `node:worker_threads` is forbidden too
 * (`domain-no-core-io`), so the pattern cannot be run with a timeout. A
 * synchronous JavaScript `RegExp` has no timeout of its own.
 *
 * So the strategy is not to *detect* catastrophic backtracking at run time —
 * it is to make it **unrepresentable** at compile time, then bound the input.
 *
 * Rejected, and why:
 *
 * | construct                          | why                                        |
 * |------------------------------------|--------------------------------------------|
 * | a quantifier on a group: `)` + `*`, `+`, `{` | the entire exponential class: `(a+)+`, `(a\|a)*`, `(a*)*b`, `(x+x+)+y` |
 * | backreferences `\1`, `\k<n>`       | the other exponential class                |
 * | lookahead / lookbehind             | unbounded, poorly bounded cost             |
 * | more than three open-ended quantifiers | each one adds a factor of `n`          |
 * | `{n,m}` with a bound above 64      | keeps bounded repetition actually bounded  |
 *
 * `)?` is deliberately **allowed**: an optional group matches at most once and
 * cannot blow up, and rejecting it would break ordinary patterns like
 * `(?:sq )?daves`.
 *
 * What remains is polynomial in the number of open-ended quantifiers, and both
 * that count and the input length are capped at values chosen by **measuring**
 * the worst permitted pattern rather than by reasoning about step counts — see
 * `MAX_UNBOUNDED_QUANTIFIERS`. The worst case the caps admit is roughly 18ms
 * cold. The tests assert both halves: every known catastrophic pattern is
 * rejected at compile time, and the worst *permitted* pattern runs against a
 * full-length adversarial input inside a time budget that a regression past
 * these caps would blow by an order of magnitude.
 */
export function compileRulePattern(source: string): Result<SafeRulePattern, RegexRejection> {
  if (source === '') {
    return rejectRegex('empty', 'A regex rule needs a pattern');
  }
  if (source.length > MAX_RULE_PATTERN_LENGTH) {
    return rejectRegex(
      'too-long',
      `Pattern is ${String(source.length)} characters; the limit is ${String(MAX_RULE_PATTERN_LENGTH)}`,
    );
  }

  let index = 0;
  let inCharacterClass = false;
  let previousWasGroupClose = false;
  let previousWasQuantifier = false;
  let unboundedQuantifiers = 0;

  while (index < source.length) {
    const char = source.charAt(index);

    if (inCharacterClass) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === ']') inCharacterClass = false;
      index += 1;
      previousWasGroupClose = false;
      previousWasQuantifier = false;
      continue;
    }

    if (char === '\\') {
      const next = source.charAt(index + 1);
      if (next >= '1' && next <= '9') {
        return rejectRegex(
          'backreference',
          'Backreferences are not allowed: they are a catastrophic-backtracking vector',
        );
      }
      if (next === 'k') {
        return rejectRegex(
          'backreference',
          'Named backreferences are not allowed: they are a catastrophic-backtracking vector',
        );
      }
      index += 2;
      previousWasGroupClose = false;
      previousWasQuantifier = false;
      continue;
    }

    if (char === '[') {
      inCharacterClass = true;
      index += 1;
      previousWasGroupClose = false;
      previousWasQuantifier = false;
      continue;
    }

    if (char === '(') {
      const head = source.slice(index, index + 4);
      if (
        head.startsWith('(?=') ||
        head.startsWith('(?!') ||
        head.startsWith('(?<=') ||
        head.startsWith('(?<!')
      ) {
        return rejectRegex(
          'lookaround',
          'Lookahead and lookbehind are not allowed: their backtracking cost is not bounded',
        );
      }
      index += 1;
      previousWasGroupClose = false;
      previousWasQuantifier = false;
      continue;
    }

    if (char === ')') {
      index += 1;
      previousWasGroupClose = true;
      previousWasQuantifier = false;
      continue;
    }

    if (char === '*' || char === '+') {
      if (previousWasGroupClose) {
        return rejectRegex(
          'quantified-group',
          `A group cannot be repeated with "${char}": that is the shape of (a+)+ and (a|a)*`,
        );
      }
      unboundedQuantifiers += 1;
      index += 1;
      previousWasGroupClose = false;
      previousWasQuantifier = true;
      continue;
    }

    if (char === '?') {
      // Either the lazy modifier on a preceding quantifier, or an optional
      // atom. Both are bounded, and `(...)?` matches at most once.
      index += 1;
      previousWasGroupClose = false;
      previousWasQuantifier = !previousWasQuantifier;
      continue;
    }

    if (char === '{') {
      const repetition = REPETITION_PATTERN.exec(source.slice(index));
      if (repetition === null) {
        // A literal brace, not a quantifier.
        index += 1;
        previousWasGroupClose = false;
        previousWasQuantifier = false;
        continue;
      }
      if (previousWasGroupClose) {
        return rejectRegex(
          'quantified-group',
          'A group cannot be repeated with {n,m}: bounded repetition of a group still backtracks exponentially',
        );
      }
      const lowerText = repetition[1] ?? '0';
      const upperText = repetition[2];
      const lower = Number(lowerText);
      if (upperText === '') {
        // `{n,}` is open-ended.
        unboundedQuantifiers += 1;
      } else {
        const upper = upperText === undefined ? lower : Number(upperText);
        if (upper > MAX_BOUNDED_REPETITION || lower > MAX_BOUNDED_REPETITION) {
          return rejectRegex(
            'repetition-too-large',
            `Repetition bound exceeds ${String(MAX_BOUNDED_REPETITION)}`,
          );
        }
      }
      index += repetition[0].length;
      previousWasGroupClose = false;
      previousWasQuantifier = true;
      continue;
    }

    index += 1;
    previousWasGroupClose = false;
    previousWasQuantifier = false;
  }

  if (unboundedQuantifiers > MAX_UNBOUNDED_QUANTIFIERS) {
    return rejectRegex(
      'too-many-unbounded-quantifiers',
      `Pattern has ${String(unboundedQuantifiers)} open-ended quantifiers; the limit is ${String(MAX_UNBOUNDED_QUANTIFIERS)}`,
    );
  }

  let compiled: RegExp;
  try {
    // `i` only. The `u` flag would turn otherwise-valid user patterns into
    // syntax errors, which is a worse experience for no safety gain here.
    compiled = new RegExp(source, 'i');
  } catch (caught: unknown) {
    return rejectRegex(
      'invalid-syntax',
      caught instanceof Error ? caught.message : 'Pattern is not valid regular expression syntax',
    );
  }

  return ok({
    source,
    test(value: string): boolean {
      // Truncation is the other half of the bound: the polynomial worst case is
      // only tolerable because n is capped.
      compiled.lastIndex = 0;
      return compiled.test(value.slice(0, MAX_MATCH_INPUT_LENGTH));
    },
  });
}

/* ── Text normalization ──────────────────────────────────────────────────── */

/**
 * Fold a string for substring matching: NFKC, lowercase, collapsed whitespace.
 *
 * `description` arrives as the institution wrote it — usually upper case, often
 * with runs of padding spaces — while a user types rules in ordinary case. NFKC
 * additionally folds full-width and ligature forms that appear in some exports.
 */
export function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* ── Rule validation ─────────────────────────────────────────────────────── */

function invalidRule(
  rule: CategorizationRule,
  field: string,
  code: string,
  message: string,
): never {
  throw new ValidationError(message, {
    details: [{ field, code, actual: rule.id }],
  });
}

/**
 * Structural validation, run when a rule is created or updated.
 *
 * `matchRule` calls this too, so a malformed rule fails loudly rather than
 * silently never matching. A rule that quietly matches nothing is worse than
 * one that throws: the user sees transactions going uncategorized and has no
 * way to discover why.
 */
export function assertValidRule(rule: CategorizationRule): void {
  switch (rule.matchType) {
    case 'merchant_contains':
    case 'description_contains': {
      if (normalizeForMatch(rule.matchValue) === '') {
        invalidRule(
          rule,
          'matchValue',
          'EMPTY_MATCH_VALUE',
          `Rule ${rule.id} (${rule.matchType}) needs a non-empty match value`,
        );
      }
      return;
    }
    case 'merchant_regex': {
      const compiled = compileRulePattern(rule.matchValue);
      if (!compiled.ok) {
        invalidRule(
          rule,
          'matchValue',
          `REGEX_${compiled.error.code.toUpperCase().replace(/-/g, '_')}`,
          `Rule ${rule.id} has an unsafe or invalid pattern: ${compiled.error.message}`,
        );
      }
      return;
    }
    case 'amount_equals': {
      if (rule.amountMin === null) {
        invalidRule(
          rule,
          'amountMin',
          'MISSING_AMOUNT',
          `Rule ${rule.id} (amount_equals) needs amountMin to hold the exact amount`,
        );
      }
      if (rule.amountMax !== null && rule.amountMax !== rule.amountMin) {
        invalidRule(
          rule,
          'amountMax',
          'CONFLICTING_AMOUNT',
          `Rule ${rule.id} (amount_equals) must leave amountMax null or equal to amountMin`,
        );
      }
      return;
    }
    case 'amount_between': {
      if (rule.amountMin === null || rule.amountMax === null) {
        invalidRule(
          rule,
          rule.amountMin === null ? 'amountMin' : 'amountMax',
          'MISSING_BOUND',
          `Rule ${rule.id} (amount_between) needs both amountMin and amountMax`,
        );
      }
      if (rule.amountMin > rule.amountMax) {
        invalidRule(
          rule,
          'amountMin',
          'INVERTED_BOUNDS',
          `Rule ${rule.id} has amountMin ${toJsonMinor(rule.amountMin)} above amountMax ${toJsonMinor(rule.amountMax)}`,
        );
      }
      return;
    }
  }
}

/* ── Matching ────────────────────────────────────────────────────────────── */

function matchesAccount(rule: CategorizationRule, tx: MatchableTransaction): boolean {
  return rule.accountId === null || rule.accountId === tx.accountId;
}

/**
 * Does this rule match this transaction?
 *
 * Ignores `isEnabled` and priority — those are `findFirstMatchingRule`'s job.
 * Throws `ValidationError` on a structurally invalid rule.
 */
export function matchRule(rule: CategorizationRule, tx: MatchableTransaction): boolean {
  assertValidRule(rule);

  if (!matchesAccount(rule, tx)) return false;

  switch (rule.matchType) {
    case 'merchant_contains': {
      if (tx.merchantNormalized === null) return false;
      return normalizeForMatch(tx.merchantNormalized).includes(normalizeForMatch(rule.matchValue));
    }
    case 'description_contains': {
      return normalizeForMatch(tx.description).includes(normalizeForMatch(rule.matchValue));
    }
    case 'merchant_regex': {
      if (tx.merchantNormalized === null) return false;
      const compiled = compileRulePattern(rule.matchValue);
      // assertValidRule already proved this compiles; the guard keeps the
      // types honest without a cast.
      return compiled.ok && compiled.value.test(tx.merchantNormalized);
    }
    case 'amount_equals': {
      return tx.amount === rule.amountMin;
    }
    case 'amount_between': {
      // Inclusive on both ends, signed.
      return (
        rule.amountMin !== null &&
        rule.amountMax !== null &&
        tx.amount >= rule.amountMin &&
        tx.amount <= rule.amountMax
      );
    }
  }
}

/**
 * Enabled rules in evaluation order: priority ascending, then `id` ascending.
 *
 * The tie-break matters. IDs are UUIDv7 and therefore time-ordered, so equal
 * priorities resolve to "the older rule wins" — deterministic, explicable to a
 * user, and stable across queries in a way that database row order is not.
 */
export function orderRules(rules: readonly CategorizationRule[]): CategorizationRule[] {
  return rules
    .filter((rule) => rule.isEnabled)
    .sort((a, b) =>
      a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority - b.priority,
    );
}

/** First matching enabled rule in priority order, or `null` (§10.1 tier 3). */
export function findFirstMatchingRule(
  rules: readonly CategorizationRule[],
  tx: MatchableTransaction,
): RuleMatch | null {
  for (const rule of orderRules(rules)) {
    if (matchRule(rule, tx)) {
      return { rule, categoryId: rule.categoryId, markAsTransfer: rule.markAsTransfer };
    }
  }
  return null;
}
