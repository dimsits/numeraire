import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MINOR_SCALE,
  MAX_MINOR_SCALE,
  absMinor,
  absMoney,
  addMinor,
  addMoney,
  allocate,
  allocateMoney,
  compareMinor,
  compareMoney,
  formatMinor,
  formatMoney,
  fromJsonMinor,
  isSameCurrency,
  isValidCurrencyCode,
  isZeroMinor,
  isZeroMoney,
  money,
  negateMinor,
  negateMoney,
  parseMinor,
  parseMinorOrThrow,
  signOfMinor,
  subtractMinor,
  subtractMoney,
  toJsonMinor,
} from '@/domain/money/money.js';
import { CurrencyMismatchError, ValidationError } from '@/domain/errors.js';
import { expectErr, expectOk, expectThrows } from '@tests/helpers/expect.js';
import type { Minor } from '@/domain/money/money.js';

/** Titles a bigint-bearing table row so vitest never has to format a bigint. */
function titled<T>(rows: readonly T[], title: (row: T) => string): readonly [string, T][] {
  return rows.map((row) => [title(row), row]);
}

/** `String`, as an expression — bigint is not allowed in a template literal. */
const s = String;

const sum = (parts: readonly Minor[]): Minor => parts.reduce<bigint>((a, b) => a + b, 0n);

const PHP = 'PHP';
const USD = 'USD';

describe('minor-unit arithmetic', () => {
  it.each(
    titled(
      [
        { a: 0n, b: 0n, expected: 0n },
        { a: 45000n, b: 5000n, expected: 50000n },
        { a: -45000n, b: -5000n, expected: -50000n },
        { a: -45000n, b: 45000n, expected: 0n },
        { a: 1n, b: -2n, expected: -1n },
        // Past 2^53: the reason ADR-002 chose bigint over number.
        { a: 9007199254740993n, b: 1n, expected: 9007199254740994n },
        { a: 10n ** 30n, b: 1n, expected: 10n ** 30n + 1n },
      ],
      (r) => `${s(r.a)} + ${s(r.b)} = ${s(r.expected)}`,
    ),
  )('adds %s', (_title, { a, b, expected }) => {
    expect(addMinor(a, b)).toBe(expected);
  });

  it.each(
    titled(
      [
        { a: 0n, b: 0n, expected: 0n },
        { a: 50000n, b: 5000n, expected: 45000n },
        { a: -45000n, b: 5000n, expected: -50000n },
        { a: 5000n, b: 50000n, expected: -45000n },
        { a: 9007199254740994n, b: 1n, expected: 9007199254740993n },
      ],
      (r) => `${s(r.a)} - ${s(r.b)} = ${s(r.expected)}`,
    ),
  )('subtracts %s', (_title, { a, b, expected }) => {
    expect(subtractMinor(a, b)).toBe(expected);
  });

  it.each(
    titled(
      [
        { input: 0n, negated: 0n, absolute: 0n },
        { input: 45000n, negated: -45000n, absolute: 45000n },
        { input: -45000n, negated: 45000n, absolute: 45000n },
        { input: 1n, negated: -1n, absolute: 1n },
      ],
      (r) => s(r.input),
    ),
  )('negates and takes the magnitude of %s', (_title, { input, negated, absolute }) => {
    expect(negateMinor(input)).toBe(negated);
    expect(absMinor(input)).toBe(absolute);
  });

  it('has no negative zero', () => {
    // bigint, unlike number, cannot represent -0. A parsed "-0.00" is 0n.
    expect(negateMinor(0n)).toBe(0n);
    expect(Object.is(negateMinor(0n), 0n)).toBe(true);
  });

  it.each(
    titled(
      [
        { a: 0n, b: 0n, expected: 0 as const },
        { a: 1n, b: 2n, expected: -1 as const },
        { a: 2n, b: 1n, expected: 1 as const },
        { a: -2n, b: -1n, expected: -1 as const },
        { a: -1n, b: 1n, expected: -1 as const },
        { a: 9007199254740993n, b: 9007199254740992n, expected: 1 as const },
      ],
      (r) => `${s(r.a)} vs ${s(r.b)} = ${s(r.expected)}`,
    ),
  )('compares %s', (_title, { a, b, expected }) => {
    expect(compareMinor(a, b)).toBe(expected);
  });

  it('sorts with compareMinor', () => {
    expect([50n, -10n, 0n, 3n].sort(compareMinor)).toEqual([-10n, 0n, 3n, 50n]);
  });

  it.each(
    titled(
      [
        { input: -45000n, sign: -1 as const, zero: false },
        { input: 0n, sign: 0 as const, zero: true },
        { input: 45000n, sign: 1 as const, zero: false },
      ],
      (r) => s(r.input),
    ),
  )('reports sign and zero-ness of %s', (_title, { input, sign, zero }) => {
    expect(signOfMinor(input)).toBe(sign);
    expect(isZeroMinor(input)).toBe(zero);
  });
});

describe('currency codes', () => {
  it.each(['PHP', 'USD', 'JPY', 'KWD', 'XAU'])('accepts %s', (code) => {
    expect(isValidCurrencyCode(code)).toBe(true);
  });

  it.each(['php', 'Php', 'PH', 'PHPP', '', 'P1P', 'P-P', '123', ' PHP', 'PHP '])(
    'rejects %s',
    (code) => {
      expect(isValidCurrencyCode(code)).toBe(false);
      expect(() => money(0n, code)).toThrow(ValidationError);
    },
  );

  it('does not silently upper-case a lowercase code', () => {
    // Normalizing "php" would hide a column-mapping bug in an import (§9.2).
    expect(() => money(100n, 'php')).toThrow(/three-letter uppercase/);
  });
});

describe('Money compatibility', () => {
  const a = money(-45000n, PHP);
  const b = money(-5000n, PHP);
  const foreign = money(-5000n, USD);

  it('adds, subtracts and compares within one currency', () => {
    expect(addMoney(a, b)).toEqual({ amount: -50000n, currency: PHP });
    expect(subtractMoney(a, b)).toEqual({ amount: -40000n, currency: PHP });
    expect(compareMoney(a, b)).toBe(-1);
    expect(compareMoney(b, a)).toBe(1);
    expect(compareMoney(a, a)).toBe(0);
  });

  it('negates, takes magnitude and tests zero without needing a second operand', () => {
    expect(negateMoney(a)).toEqual({ amount: 45000n, currency: PHP });
    expect(absMoney(a)).toEqual({ amount: 45000n, currency: PHP });
    expect(isZeroMoney(money(0n, PHP))).toBe(true);
    expect(isZeroMoney(a)).toBe(false);
  });

  it('reports currency sameness', () => {
    expect(isSameCurrency(a, b)).toBe(true);
    expect(isSameCurrency(a, foreign)).toBe(false);
  });

  it.each([
    ['addMoney', () => addMoney(a, foreign)],
    ['subtractMoney', () => subtractMoney(a, foreign)],
    ['compareMoney', () => compareMoney(a, foreign)],
  ])('%s throws CurrencyMismatchError across currencies', (_name, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
    expect(operation).toThrow(/no conversion in v1/);
  });

  it('names both currencies in the mismatch detail', () => {
    const error = expectThrows(CurrencyMismatchError, () => addMoney(a, foreign));
    expect(error.details).toEqual([
      { field: 'currency', code: 'CURRENCY_MISMATCH', expected: PHP, actual: USD },
    ]);
  });

  it('preserves the currency through allocation', () => {
    expect(allocateMoney(money(1000n, PHP), [1, 1, 1])).toEqual([
      { amount: 334n, currency: PHP },
      { amount: 333n, currency: PHP },
      { amount: 333n, currency: PHP },
    ]);
  });
});

describe('parseMinor', () => {
  it.each(
    titled(
      [
        { input: '12.34', scale: 2, expected: 1234n },
        { input: '-12.34', scale: 2, expected: -1234n },
        { input: '+12.34', scale: 2, expected: 1234n },
        { input: '0.00', scale: 2, expected: 0n },
        { input: '0', scale: 2, expected: 0n },
        { input: '-0', scale: 2, expected: 0n },
        { input: '-0.00', scale: 2, expected: 0n },
        { input: '12', scale: 2, expected: 1200n },
        { input: '12.3', scale: 2, expected: 1230n },
        { input: '007.50', scale: 2, expected: 750n },
        { input: '450.00', scale: 2, expected: 45000n },
        { input: '-450.00', scale: 2, expected: -45000n },
        { input: '0.05', scale: 2, expected: 5n },
        { input: '0.01', scale: 2, expected: 1n },
        // Scale 0 — JPY has no minor unit.
        { input: '1200', scale: 0, expected: 1200n },
        { input: '-1200', scale: 0, expected: -1200n },
        // Scale 3 — KWD.
        { input: '12.345', scale: 3, expected: 12345n },
        { input: '12.3', scale: 3, expected: 12300n },
        // Beyond 2^53.
        { input: '90071992547409.93', scale: 2, expected: 9007199254740993n },
      ],
      (r) => `"${r.input}" @ scale ${s(r.scale)} -> ${s(r.expected)}`,
    ),
  )('parses %s', (_title, { input, scale, expected }) => {
    expect(expectOk(parseMinor(input, { scale }))).toBe(expected);
  });

  it.each([
    ['', 2, 'empty'],
    [' ', 2, 'not-numeric'],
    ['-', 2, 'not-numeric'],
    ['.', 2, 'not-numeric'],
    ['.5', 2, 'not-numeric'], // digits required before the point
    ['1.', 2, 'not-numeric'], // digits required after the point
    ['1,234.56', 2, 'not-numeric'], // grouping is the import pipeline's job
    ['1 234.56', 2, 'not-numeric'],
    [' 12.34', 2, 'not-numeric'], // caller trims
    ['12.34 ', 2, 'not-numeric'],
    ['1e5', 2, 'not-numeric'],
    ['NaN', 2, 'not-numeric'],
    ['Infinity', 2, 'not-numeric'],
    ['₱12.34', 2, 'not-numeric'],
    ['(12.34)', 2, 'not-numeric'], // accounting negatives
    ['12.34.56', 2, 'not-numeric'],
    ['--12', 2, 'not-numeric'],
    ['0x10', 2, 'not-numeric'],
    ['12.345', 2, 'too-many-decimals'],
    ['12.5', 0, 'too-many-decimals'],
    ['12.3456', 3, 'too-many-decimals'],
  ])('rejects "%s" at scale %i as %s', (input, scale, code) => {
    expect(expectErr(parseMinor(input, { scale })).code).toBe(code);
  });

  it('never rounds a value with too many decimals', () => {
    // Silently producing 1234n or 1235n here is how a ledger stops reconciling.
    expect(expectErr(parseMinor('12.345', { scale: 2 })).code).toBe('too-many-decimals');
  });

  it.each([-1, 1.5, MAX_MINOR_SCALE + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws on scale %s rather than reporting it as bad input',
    (scale) => {
      // A bad scale is a caller bug, not a failure of the user's data. If it
      // came back as a ParseMinorIssue, an import loop would blame the CSV.
      const error = expectThrows(ValidationError, () => parseMinor('12.34', { scale }));
      expect(error.details?.[0]?.field).toBe('scale');
    },
  );

  it('carries the offending input on the issue', () => {
    expect(expectErr(parseMinor('1,234.56', { scale: 2 })).input).toBe('1,234.56');
  });
});

describe('parseMinorOrThrow', () => {
  it('returns the value on success', () => {
    expect(parseMinorOrThrow('-450.00', { scale: DEFAULT_MINOR_SCALE })).toBe(-45000n);
  });

  it('throws ValidationError with a machine-readable detail code', () => {
    const error = expectThrows(ValidationError, () => parseMinorOrThrow('12.345', { scale: 2 }));
    expect(error.details?.[0]?.code).toBe('TOO_MANY_DECIMALS');
    expect(error.details?.[0]?.actual).toBe('12.345');
  });

  it.each([
    ['', 'EMPTY'],
    ['abc', 'NOT_NUMERIC'],
  ])('maps "%s" to detail code %s', (input, code) => {
    const error = expectThrows(ValidationError, () => parseMinorOrThrow(input, { scale: 2 }));
    expect(error.details?.[0]?.code).toBe(code);
  });
});

describe('formatMinor', () => {
  it.each(
    titled(
      [
        { amount: 0n, scale: 2, expected: '0.00' },
        { amount: 5n, scale: 2, expected: '0.05' },
        { amount: -5n, scale: 2, expected: '-0.05' },
        { amount: 1n, scale: 2, expected: '0.01' },
        { amount: 99n, scale: 2, expected: '0.99' },
        { amount: 100n, scale: 2, expected: '1.00' },
        { amount: -45000n, scale: 2, expected: '-450.00' },
        { amount: 45000n, scale: 2, expected: '450.00' },
        { amount: 1234n, scale: 0, expected: '1234' },
        { amount: -1234n, scale: 0, expected: '-1234' },
        { amount: 12345n, scale: 3, expected: '12.345' },
        { amount: 5n, scale: 3, expected: '0.005' },
        { amount: 9007199254740993n, scale: 2, expected: '90071992547409.93' },
      ],
      (r) => `${s(r.amount)} @ scale ${s(r.scale)} -> "${r.expected}"`,
    ),
  )('formats %s', (_title, { amount, scale, expected }) => {
    expect(formatMinor(amount, { scale })).toBe(expected);
  });

  it('emits no decimal point at scale 0', () => {
    expect(formatMinor(1200n, { scale: 0 })).not.toContain('.');
  });

  it.each([
    [1234567n, ',', '12,345.67'],
    [123456n, ',', '1,234.56'],
    [12345n, ',', '123.45'],
    [1234n, ',', '12.34'],
    [123456789n, ' ', '1 234 567.89'],
  ])('groups %s with "%s" as %s', (amount, groupSeparator, expected) => {
    expect(formatMinor(amount, { scale: 2, groupSeparator })).toBe(expected);
  });

  it('groups a negative amount without separating the sign', () => {
    expect(formatMinor(-123456789n, { scale: 2, groupSeparator: ',' })).toBe('-1,234,567.89');
  });

  it.each([
    ['groupSeparator collides with the default decimal separator', { groupSeparator: '.' }],
    ['both separators are the same character', { groupSeparator: ',', decimalSeparator: ',' }],
  ])('rejects ambiguous separators when %s', (_label, options) => {
    // "12.345.678.90" is unreadable and unparseable. Refusing beats emitting it.
    const error = expectThrows(ValidationError, () =>
      formatMinor(1234567890n, { scale: 2, ...options }),
    );
    expect(error.details?.[0]?.code).toBe('SEPARATOR_COLLISION');
  });

  it.each([
    ['a digit', { groupSeparator: '5' }],
    ['a minus sign', { groupSeparator: '-' }],
    ['a plus sign', { decimalSeparator: '+' }],
  ])('rejects a separator containing %s', (_label, options) => {
    const error = expectThrows(ValidationError, () =>
      formatMinor(1234567n, { scale: 2, ...options }),
    );
    expect(error.details?.[0]?.code).toBe('SEPARATOR_NOT_PUNCTUATION');
  });

  it('still accepts the European convention, where the two differ', () => {
    expect(formatMinor(1234567890n, { scale: 2, decimalSeparator: ',', groupSeparator: '.' })).toBe(
      '12.345.678,90',
    );
  });

  it('accepts a custom decimal separator', () => {
    expect(formatMinor(123456n, { scale: 2, decimalSeparator: ',', groupSeparator: '.' })).toBe(
      '1.234,56',
    );
  });

  it.each([
    [45000n, 'always', '+450.00'],
    [-45000n, 'always', '-450.00'],
    [0n, 'always', '+0.00'],
    [45000n, 'auto', '450.00'],
    [0n, 'auto', '0.00'],
  ] as const)('renders %s with sign mode %s as %s', (amount, sign, expected) => {
    expect(formatMinor(amount, { scale: 2, sign })).toBe(expected);
  });

  it.each([-1, 1.5, MAX_MINOR_SCALE + 1])('throws on scale %s', (scale) => {
    expect(
      expectThrows(ValidationError, () => formatMinor(1n, { scale })).details?.[0]?.field,
    ).toBe('scale');
  });

  it('does not use Intl, so output cannot vary by machine locale', () => {
    // Deterministic across CI and any developer machine — the reason
    // separators are explicit parameters rather than locale-derived.
    expect(formatMinor(1234567n, { scale: 2, groupSeparator: ',' })).toBe('12,345.67');
  });

  it('round-trips through parseMinor when ungrouped', () => {
    for (const amount of [0n, 1n, -1n, 45000n, -45000n, 9007199254740993n]) {
      for (const scale of [0, 2, 3]) {
        expect(expectOk(parseMinor(formatMinor(amount, { scale }), { scale }))).toBe(amount);
      }
    }
  });
});

describe('formatMoney', () => {
  it('appends the currency code', () => {
    expect(formatMoney(money(-45000n, PHP), { scale: 2 })).toBe('-450.00 PHP');
    expect(formatMoney(money(1200n, 'JPY'), { scale: 0 })).toBe('1200 JPY');
  });
});

describe('JSON boundary (§6.4, §13.1)', () => {
  it('serializes as a string of MINOR units, not a decimal string', () => {
    // { "amount": "-45000" } — not "-450.00", and not the number -45000.
    expect(toJsonMinor(-45000n)).toBe('-45000');
    expect(toJsonMinor(0n)).toBe('0');
    expect(toJsonMinor(9007199254740993n)).toBe('9007199254740993');
  });

  it('is distinct from formatMinor', () => {
    const amount = -45000n;
    expect(toJsonMinor(amount)).toBe('-45000');
    expect(formatMinor(amount, { scale: 2 })).toBe('-450.00');
    expect(toJsonMinor(amount)).not.toBe(formatMinor(amount, { scale: 2 }));
  });

  it('exists because JSON.stringify throws on a bigint', () => {
    expect(() => JSON.stringify({ amount: -45000n })).toThrow(TypeError);
    expect(() => JSON.stringify({ amount: toJsonMinor(-45000n) })).not.toThrow();
    expect(JSON.stringify({ amount: toJsonMinor(-45000n) })).toBe('{"amount":"-45000"}');
  });

  it.each(['0', '-45000', '45000', '+45000', '9007199254740993'])('parses "%s" back', (value) => {
    expect(toJsonMinor(expectOk(fromJsonMinor(value)))).toBe(value.replace('+', ''));
  });

  it.each([
    ['', 'empty'],
    ['-450.00', 'not-numeric'], // a decimal string is not the wire format
    ['abc', 'not-numeric'],
    ['4 5', 'not-numeric'],
    ['0x10', 'not-numeric'],
  ])('rejects "%s" as %s', (value, code) => {
    expect(expectErr(fromJsonMinor(value)).code).toBe(code);
  });

  it('round-trips any amount', () => {
    for (const amount of [0n, 1n, -1n, -45000n, 10n ** 25n, -(10n ** 25n)]) {
      expect(expectOk(fromJsonMinor(toJsonMinor(amount)))).toBe(amount);
    }
  });
});

describe('allocate — table-driven', () => {
  it('splits 1000 across [1,1,1] as [334, 333, 333], exactly and in order', () => {
    // The canonical case from ARCHITECTURE.MD §6.4 and §18.2. Never
    // [333, 333, 333] — that silently drops a centavo.
    expect(allocate(1000n, [1, 1, 1])).toEqual([334n, 333n, 333n]);
    expect(sum(allocate(1000n, [1, 1, 1]))).toBe(1000n);
  });

  it.each(
    titled(
      [
        { total: 1000n, weights: [1, 1, 1], expected: [334n, 333n, 333n] },
        { total: -1000n, weights: [1, 1, 1], expected: [-334n, -333n, -333n] },
        { total: 0n, weights: [1, 1, 1], expected: [0n, 0n, 0n] },
        { total: 100n, weights: [1], expected: [100n] },
        { total: -100n, weights: [1], expected: [-100n] },
        { total: 100n, weights: [1, 1], expected: [50n, 50n] },
        { total: 101n, weights: [1, 1], expected: [51n, 50n] },
        { total: -101n, weights: [1, 1], expected: [-51n, -50n] },
        { total: 10n, weights: [1, 1, 1, 1, 1, 1, 1], expected: [2n, 2n, 2n, 1n, 1n, 1n, 1n] },
        { total: 2n, weights: [1, 1, 1], expected: [1n, 1n, 0n] },
        { total: 10n, weights: [1, 2], expected: [3n, 7n] },
        { total: 100n, weights: [1, 2, 3], expected: [17n, 33n, 50n] },
        { total: 1000n, weights: [0, 1, 1], expected: [0n, 500n, 500n] },
        { total: 12000n, weights: [2500, 2500, 5000], expected: [3000n, 3000n, 6000n] },
        // A weight of zero receives nothing, even when a remainder is going spare.
        { total: 7n, weights: [0, 1, 1], expected: [0n, 4n, 3n] },
      ],
      (r) => `${s(r.total)} across [${r.weights.join(',')}]`,
    ),
  )('allocates %s', (_title, { total, weights, expected }) => {
    const parts = allocate(total, weights);
    expect(parts).toEqual(expected);
    expect(sum(parts)).toBe(total);
  });

  it('breaks remainder ties toward the lowest index, deterministically', () => {
    expect(allocate(1000n, [1, 1, 1])).toEqual([334n, 333n, 333n]);
    expect(allocate(2n, [1, 1, 1])).toEqual([1n, 1n, 0n]);
    expect(allocate(1n, [1, 1, 1])).toEqual([1n, 0n, 0n]);
    expect(allocate(-1n, [1, 1, 1])).toEqual([-1n, 0n, 0n]);
  });

  it('returns the same array for the same input, every time', () => {
    const first = allocate(1000n, [3, 3, 3, 1]);
    for (let run = 0; run < 5; run += 1) {
      expect(allocate(1000n, [3, 3, 3, 1])).toEqual(first);
    }
  });

  it('mirrors exactly under negation', () => {
    const weights = [5, 3, 1, 7, 2];
    const positive = allocate(9999n, weights);
    const negative = allocate(-9999n, weights);
    expect(negative).toEqual(positive.map((part) => -part));
  });

  it('handles totals beyond 2^53', () => {
    const total = 9007199254740993n;
    const parts = allocate(total, [1, 1, 1]);
    expect(sum(parts)).toBe(total);
  });

  it.each([
    ['an empty weight list', [] as number[]],
    ['all-zero weights', [0, 0, 0]],
    ['a single zero weight', [0]],
    ['a negative weight', [1, -1]],
    ['a fractional weight', [1.5, 1]],
    ['NaN', [Number.NaN, 1]],
    ['Infinity', [Number.POSITIVE_INFINITY, 1]],
    ['-Infinity', [Number.NEGATIVE_INFINITY, 1]],
    ['an unsafe integer', [Number.MAX_SAFE_INTEGER + 1, 1]],
  ])('rejects %s', (_label, weights) => {
    expect(() => allocate(1000n, weights)).toThrow(ValidationError);
  });

  it('names the offending index in the error detail', () => {
    const error = expectThrows(ValidationError, () => allocate(1000n, [1, 1, -3]));
    expect(error.details?.[0]?.field).toBe('weights[2]');
    expect(error.details?.[0]?.code).toBe('NEGATIVE');
  });

  it('distinguishes an empty list from zero-summing weights', () => {
    expect(() => allocate(1000n, [])).toThrow(/at least one weight/);
    expect(() => allocate(1000n, [0, 0])).toThrow(/sum to more than zero/);
  });
});

describe('allocate — properties (fast-check)', () => {
  /**
   * The DEV_PIPELINE.MD Phase 1 exit criterion: "property tests for `allocate`
   * pass 1000+ generated cases". Deliberately a separate literal from the
   * `numRuns` configuration below — asserting the counter against `NUM_RUNS`
   * would only prove fast-check ran as many cases as it was told to, and would
   * still pass if someone lowered the configuration to 10.
   */
  const REQUIRED_GENERATED_CASES = 1000;
  const NUM_RUNS = 1000;

  /** Totals span both signs and comfortably exceed 2^53. */
  const totalArb = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
  /** At least one weight, at least one of them positive. */
  const weightsArb = fc
    .array(fc.nat({ max: 10_000 }), { minLength: 1, maxLength: 12 })
    .filter((weights) => weights.some((weight) => weight > 0));

  it(`exercises at least ${String(REQUIRED_GENERATED_CASES)} generated cases`, () => {
    // Counts the predicate invocations rather than trusting the configuration,
    // and checks the count against the criterion's own literal.
    let generatedCases = 0;
    fc.assert(
      fc.property(totalArb, weightsArb, (total, weights) => {
        generatedCases += 1;
        return sum(allocate(total, weights)) === total;
      }),
      { numRuns: NUM_RUNS },
    );
    expect(generatedCases).toBeGreaterThanOrEqual(REQUIRED_GENERATED_CASES);
  });

  it('preserves the sum exactly', () => {
    fc.assert(
      fc.property(
        totalArb,
        weightsArb,
        (total, weights) => sum(allocate(total, weights)) === total,
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves the sign on every part', () => {
    fc.assert(
      fc.property(totalArb, weightsArb, (total, weights) => {
        const parts = allocate(total, weights);
        if (total > 0n) return parts.every((part) => part >= 0n);
        if (total < 0n) return parts.every((part) => part <= 0n);
        return parts.every((part) => part === 0n);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never gives a larger weight a smaller allocation', () => {
    fc.assert(
      fc.property(totalArb, weightsArb, (total, weights) => {
        const parts = allocate(total, weights);
        for (let i = 0; i < weights.length; i += 1) {
          for (let j = 0; j < weights.length; j += 1) {
            const [wi, wj] = [weights[i], weights[j]];
            const [pi, pj] = [parts[i], parts[j]];
            if (wi === undefined || wj === undefined || pi === undefined || pj === undefined) {
              return false;
            }
            if (wi <= wj) continue;
            // For a negative total "more" means a larger magnitude, so the
            // ordering flips with the sign.
            if (total >= 0n ? pi < pj : pi > pj) return false;
          }
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns exactly one part per weight', () => {
    fc.assert(
      fc.property(
        totalArb,
        weightsArb,
        (total, weights) => allocate(total, weights).length === weights.length,
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(totalArb, weightsArb, (total, weights) => {
        const first = allocate(total, weights);
        const second = allocate(total, weights);
        return first.length === second.length && first.every((part, i) => part === second[i]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('round-trips format -> parse for any amount and scale', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.nat({ max: MAX_MINOR_SCALE }),
        (amount, scale) => {
          const parsed = parseMinor(formatMinor(amount, { scale }), { scale });
          return parsed.ok && parsed.value === amount;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('round-trips toJsonMinor -> fromJsonMinor for any amount', () => {
    fc.assert(
      fc.property(fc.bigInt(), (amount) => {
        const parsed = fromJsonMinor(toJsonMinor(amount));
        return parsed.ok && parsed.value === amount;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('exported scale constants', () => {
  it('names the common default without applying it implicitly', () => {
    expect(DEFAULT_MINOR_SCALE).toBe(2);
    expect(MAX_MINOR_SCALE).toBe(9);
  });
});
