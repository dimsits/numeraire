/**
 * Money — ARCHITECTURE.MD §6.4, ADR-002.
 *
 * The single non-negotiable rule (CLAUDE.md, ARCHITECTURE.MD P1): **money is
 * `bigint` minor units.** No `number` arithmetic, no floats, and none of the
 * float-parsing or fixed-point-formatting built-ins, anywhere on this path.
 * ESLint bans that syntax, a `scripts/check-invariants.ts` rule greps for it,
 * and dependency-cruiser keeps this module free of anything that could smuggle
 * a float in from outside. (Those built-ins are described rather than named
 * here because the invariant checker greps line by line and cannot tell a
 * comment from code — correctly, since a comment is no place to hide one.)
 *
 * Two levels, deliberately separated:
 *
 *   - **`Minor`** — a bare `bigint` count of minor units, no currency. This is
 *     what the database column holds and what `allocate` operates on.
 *   - **`Money`** — an amount paired with an ISO 4217 code. Combining two
 *     `Money` values in different currencies throws; there is no implicit
 *     conversion and no FX in v1.
 *
 * ## Three string representations, which must never be confused
 *
 * | Function       | Produces        | Used for                                  |
 * |----------------|-----------------|-------------------------------------------|
 * | `toJsonMinor`  | `"-45000"`      | the API boundary (§6.4, §13.1)            |
 * | `formatMinor`  | `"-450.00"`     | human display and logs                    |
 * | `String(x)`    | `"-45000"`      | never — use `toJsonMinor` so intent is explicit |
 *
 * `JSON.stringify` throws outright on a `bigint`, which is exactly why §13.1
 * fixes the wire format as *a string of minor units*: `{"amount": "-45000"}`.
 * That is **not** what `formatMinor` returns. Phase 3 serializes with
 * `toJsonMinor`; anything user-facing uses `formatMinor`.
 */
import { err, ok } from '@/lib/result.js';
import type { Result } from '@/lib/result.js';
import { CurrencyMismatchError, ValidationError } from '@/domain/errors.js';

/** Integer minor units — centavos, cents, satang. Never a fractional value. */
export type Minor = bigint;

/** An amount in a specific currency. */
export interface Money {
  readonly amount: Minor;
  readonly currency: string; // ISO 4217
}

/**
 * Minor units per major unit, as a power of ten. Two for PHP and USD, zero for
 * JPY, three for KWD.
 *
 * Exported as a named constant rather than used as a default: a silent default
 * of 2 turns a JPY amount into 1/100th of itself, and that class of bug is
 * invisible until someone reconciles a statement. Every parse and format call
 * states its scale.
 */
export const DEFAULT_MINOR_SCALE = 2;

/** Upper bound on `scale`, well beyond any real currency's three decimals. */
export const MAX_MINOR_SCALE = 9;

export interface MinorParseOptions {
  /** Decimal places the input carries. Required — see `DEFAULT_MINOR_SCALE`. */
  readonly scale: number;
}

export interface MinorFormatOptions {
  /** Decimal places to render. Required — see `DEFAULT_MINOR_SCALE`. */
  readonly scale: number;
  /** Thousands separator. Omitted means no grouping, which round-trips through `parseMinor`. */
  readonly groupSeparator?: string | undefined;
  /** Decimal mark. Defaults to `.`. */
  readonly decimalSeparator?: string | undefined;
  /** `'auto'` prints `-` only; `'always'` also prints `+`. Defaults to `'auto'`. */
  readonly sign?: 'auto' | 'always' | undefined;
}

/**
 * Why a bad `scale` is *not* one of these codes: `scale` is a caller argument,
 * not user data. If an invalid scale could surface as a `ParseMinorIssue`, a
 * CSV import loop would report a wrong scale constant as ten thousand
 * per-row "bad amount" errors attributed to the user's file, instead of one
 * loud bug. Every code below is, by construction, a statement about the input
 * string; a bad scale throws.
 */
export interface ParseMinorIssue {
  readonly code: 'empty' | 'not-numeric' | 'too-many-decimals';
  readonly input: string;
  readonly message: string;
}

/** Optional sign, digits, optionally a decimal point followed by digits. Nothing else. */
const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;
/** Optional sign and digits only — the wire format from §13.1. */
const INTEGER_PATTERN = /^[+-]?\d+$/;
/** ISO 4217 alphabetic code. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/* ── Minor-level arithmetic ──────────────────────────────────────────────── */

export function addMinor(a: Minor, b: Minor): Minor {
  return a + b;
}

export function subtractMinor(a: Minor, b: Minor): Minor {
  return a - b;
}

export function negateMinor(a: Minor): Minor {
  return -a;
}

export function absMinor(a: Minor): Minor {
  return a < 0n ? -a : a;
}

export function isZeroMinor(a: Minor): boolean {
  return a === 0n;
}

/** `-1` for an outflow, `1` for an inflow, `0` for nothing. */
export function signOfMinor(a: Minor): -1 | 0 | 1 {
  if (a < 0n) return -1;
  if (a > 0n) return 1;
  return 0;
}

export function compareMinor(a: Minor, b: Minor): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/* ── Allocation ──────────────────────────────────────────────────────────── */

function assertAllocatableWeights(weights: readonly number[]): void {
  if (weights.length === 0) {
    throw new ValidationError('allocate requires at least one weight', {
      details: [{ field: 'weights', code: 'EMPTY', expected: 'at least one weight', actual: '0' }],
    });
  }

  for (const [index, weight] of weights.entries()) {
    // Rejects NaN, ±Infinity, fractional values, and anything past 2^53-1 in
    // one check. A fractional weight would force float arithmetic onto the
    // money path; callers scale to integers (basis points) instead.
    if (!Number.isSafeInteger(weight)) {
      throw new ValidationError(
        `Weight at index ${String(index)} must be a safe integer, received ${String(weight)}`,
        {
          details: [
            {
              field: `weights[${String(index)}]`,
              code: 'NOT_A_SAFE_INTEGER',
              expected: 'a non-negative safe integer',
              actual: String(weight),
            },
          ],
        },
      );
    }
    if (weight < 0) {
      throw new ValidationError(
        `Weight at index ${String(index)} must not be negative, received ${String(weight)}`,
        {
          details: [
            {
              field: `weights[${String(index)}]`,
              code: 'NEGATIVE',
              expected: 'a non-negative safe integer',
              actual: String(weight),
            },
          ],
        },
      );
    }
  }
}

/**
 * Split `total` across `weights` without losing a minor unit — the
 * largest-remainder method (ARCHITECTURE.MD §6.4).
 *
 *     allocate(1000n, [1, 1, 1])  ->  [334n, 333n, 333n]
 *
 * never `[333n, 333n, 333n]`, which would quietly drop a centavo and break the
 * split-sum invariant (ADR-001) at the point where it is hardest to notice.
 *
 * **Entirely integer arithmetic.** Weights are converted to `bigint` and every
 * division truncates toward zero, so no ratio is ever held as a float. That
 * matters here more than anywhere: a `Number` ratio would introduce exactly the
 * rounding error the whole `bigint` decision exists to prevent.
 *
 * Guaranteed properties, all asserted as fast-check properties in the tests:
 *
 * - **Sum preservation** — the parts always total `total`, exactly.
 * - **Sign preservation** — every part carries `total`'s sign (or is zero).
 * - **Monotonicity** — a larger weight never receives a smaller allocation.
 * - **Determinism** — remainder ties break toward the lowest index, so the
 *   same input always yields the same output in the same order.
 *
 * Throws `ValidationError` for an empty weight list, a negative, fractional,
 * non-finite or unsafe weight, or weights that sum to zero. None of those has a
 * correct silent answer: splitting evenly instead would change the caller's
 * meaning, and returning short would violate the sum invariant.
 */
export function allocate(total: Minor, weights: readonly number[]): Minor[] {
  assertAllocatableWeights(weights);

  const totalWeight = weights.reduce<bigint>((sum, weight) => sum + BigInt(weight), 0n);
  if (totalWeight === 0n) {
    throw new ValidationError('allocate requires the weights to sum to more than zero', {
      details: [
        { field: 'weights', code: 'ZERO_TOTAL', expected: 'a positive total weight', actual: '0' },
      ],
    });
  }

  // `share` truncates toward zero, so for a negative total the remainder is
  // negative too; comparing magnitudes keeps the distribution symmetric.
  const parts = weights.map((weight, index) => {
    const numerator = total * BigInt(weight);
    const share = numerator / totalWeight;
    return { index, share, remainder: absMinor(numerator - share * totalWeight) };
  });

  const distributed = parts.reduce<bigint>((sum, part) => sum + part.share, 0n);
  const leftover = total - distributed;

  if (leftover !== 0n) {
    // |leftover| is strictly less than the number of parts, so this hands out
    // at most one extra unit per part.
    const step = leftover > 0n ? 1n : -1n;
    let remaining = absMinor(leftover);

    const byRemainder = [...parts].sort((a, b) => {
      if (a.remainder > b.remainder) return -1;
      if (a.remainder < b.remainder) return 1;
      return a.index - b.index; // deterministic tie-break: lowest index first
    });

    for (const part of byRemainder) {
      if (remaining === 0n) break;
      part.share += step;
      remaining -= 1n;
    }
  }

  return parts.map((part) => part.share);
}

/* ── Parsing and formatting ──────────────────────────────────────────────── */

function isValidScale(scale: number): boolean {
  return Number.isInteger(scale) && scale >= 0 && scale <= MAX_MINOR_SCALE;
}

function assertValidScale(scale: number): void {
  if (!isValidScale(scale)) {
    throw new ValidationError(`Scale must be an integer 0-${String(MAX_MINOR_SCALE)}`, {
      details: [
        {
          field: 'scale',
          code: 'OUT_OF_RANGE',
          expected: `0-${String(MAX_MINOR_SCALE)}`,
          actual: String(scale),
        },
      ],
    });
  }
}

/**
 * Parse a decimal string into minor units.
 *
 * Strict and locale-free by design. Grouping separators, currency symbols,
 * accounting parentheses, scientific notation and surrounding whitespace are
 * all rejected — normalizing those is the import pipeline's job (§9.2), and
 * guessing here would silently mis-read a statement.
 *
 * A value with more decimal places than `scale` is an **error**, never a
 * rounding: `"12.345"` at scale 2 does not become `1234n` or `1235n`. Losing a
 * digit without saying so is how a ledger stops reconciling.
 *
 * Returns a `Result` rather than throwing because per-row failure is the
 * expected case for a CSV import of thousands of rows; `parseMinorOrThrow`
 * covers the call sites that want an exception. An invalid `scale` is the one
 * exception — it throws, because it is a caller bug rather than bad input.
 */
export function parseMinor(
  input: string,
  options: MinorParseOptions,
): Result<Minor, ParseMinorIssue> {
  const { scale } = options;
  // Throws rather than returning an issue: a bad scale is a caller bug, and
  // must not be representable as a failure of the user's data. See the note on
  // `ParseMinorIssue`.
  assertValidScale(scale);

  if (input === '') {
    return err({
      code: 'empty',
      input,
      message: 'Expected a decimal amount, received an empty string',
    });
  }

  if (!DECIMAL_PATTERN.test(input)) {
    return err({
      code: 'not-numeric',
      input,
      message: `Expected a plain decimal amount such as "-450.00", received ${JSON.stringify(input)}`,
    });
  }

  // Sliced rather than captured: under `noUncheckedIndexedAccess` every capture
  // group reads as `string | undefined`, and guarding a case the pattern has
  // already excluded adds an unreachable branch.
  const first = input.charAt(0);
  const negative = first === '-';
  const unsigned = first === '+' || first === '-' ? input.slice(1) : input;

  const pointIndex = unsigned.indexOf('.');
  const integerText = pointIndex === -1 ? unsigned : unsigned.slice(0, pointIndex);
  const fractionText = pointIndex === -1 ? '' : unsigned.slice(pointIndex + 1);

  if (fractionText.length > scale) {
    return err({
      code: 'too-many-decimals',
      input,
      message: `${input} has ${String(fractionText.length)} decimal places but scale is ${String(scale)}`,
    });
  }

  // String concatenation into BigInt — the digits never pass through a float.
  const magnitude = BigInt(integerText + fractionText.padEnd(scale, '0'));
  return ok(negative ? -magnitude : magnitude);
}

/** `parseMinor`, throwing `ValidationError` instead of returning a failure. */
export function parseMinorOrThrow(input: string, options: MinorParseOptions): Minor {
  const parsed = parseMinor(input, options);
  if (!parsed.ok) {
    throw new ValidationError(parsed.error.message, {
      details: [
        {
          field: 'amount',
          code: parsed.error.code.toUpperCase().replace(/-/g, '_'),
          expected: `a decimal amount with at most ${String(options.scale)} decimal places`,
          actual: parsed.error.input,
        },
      ],
    });
  }
  return parsed.value;
}

/**
 * Reject separator choices that make the output ambiguous or unparseable.
 *
 * `{ groupSeparator: '.' }` against the default decimal separator yields
 * `12.345.678.90`, which no reader — and no parser — can resolve. A separator
 * containing a digit or a sign character is worse still. The European
 * convention (`decimalSeparator: ','` with `groupSeparator: '.'`) stays legal.
 */
function assertDistinctSeparators(groupSeparator: string, decimalSeparator: string): void {
  if (groupSeparator !== '' && groupSeparator === decimalSeparator) {
    throw new ValidationError(
      `groupSeparator and decimalSeparator are both ${JSON.stringify(groupSeparator)}, which makes the output ambiguous`,
      {
        details: [
          {
            field: 'groupSeparator',
            code: 'SEPARATOR_COLLISION',
            expected: 'a separator distinct from decimalSeparator',
            actual: groupSeparator,
          },
        ],
      },
    );
  }

  for (const [field, separator] of [
    ['groupSeparator', groupSeparator],
    ['decimalSeparator', decimalSeparator],
  ] as const) {
    if (/[\d+-]/.test(separator)) {
      throw new ValidationError(
        `${field} must not contain a digit or a sign character, received ${JSON.stringify(separator)}`,
        {
          details: [
            {
              field,
              code: 'SEPARATOR_NOT_PUNCTUATION',
              expected: 'punctuation or whitespace',
              actual: separator,
            },
          ],
        },
      );
    }
  }
}

/** Insert `separator` every three digits from the right. */
function group(digits: string, separator: string): string {
  const headLength = digits.length % 3 === 0 ? 3 : digits.length % 3;
  const groups = [digits.slice(0, headLength)];
  for (let index = headLength; index < digits.length; index += 3) {
    groups.push(digits.slice(index, index + 3));
  }
  return groups.join(separator);
}

/**
 * Render minor units as a decimal string, for humans.
 *
 * `Intl.NumberFormat` is deliberately not used: it reads the ambient locale,
 * which makes output non-deterministic across machines and untestable in CI.
 * Separators are passed explicitly instead.
 *
 * Output round-trips through `parseMinor` at the same scale whenever no
 * `groupSeparator` is set. **This is not the wire format** — the API sends
 * minor units as a string via `toJsonMinor` (§6.4).
 */
export function formatMinor(amount: Minor, options: MinorFormatOptions): string {
  assertValidScale(options.scale);

  const { scale } = options;
  const decimalSeparator = options.decimalSeparator ?? '.';
  const groupSeparator = options.groupSeparator ?? '';
  const signMode = options.sign ?? 'auto';

  assertDistinctSeparators(groupSeparator, decimalSeparator);

  const negative = amount < 0n;
  // `bigint.toString()` is an exact decimal expansion — no float involved.
  const digits = absMinor(amount)
    .toString()
    .padStart(scale + 1, '0');

  const integerText = digits.slice(0, digits.length - scale);
  const fractionText = digits.slice(digits.length - scale);

  const integerPart = groupSeparator === '' ? integerText : group(integerText, groupSeparator);
  const body = scale === 0 ? integerPart : `${integerPart}${decimalSeparator}${fractionText}`;

  if (negative) return `-${body}`;
  return signMode === 'always' ? `+${body}` : body;
}

/**
 * Serialize for the API boundary — a **string of minor units** (§6.4, §13.1).
 *
 *     toJsonMinor(-45000n)  ->  "-45000"      // { "amount": "-45000" }
 *
 * Not a decimal string. `JSON.stringify` throws on a raw `bigint`, and a JSON
 * number would lose precision in a JS client past 2^53; a string of minor units
 * is exact and unambiguous.
 */
export function toJsonMinor(amount: Minor): string {
  return amount.toString();
}

/** Inverse of `toJsonMinor`. Rejects anything with a decimal point. */
export function fromJsonMinor(value: string): Result<Minor, ParseMinorIssue> {
  if (value === '') {
    return err({
      code: 'empty',
      input: value,
      message: 'Expected minor units, received an empty string',
    });
  }
  if (!INTEGER_PATTERN.test(value)) {
    return err({
      code: 'not-numeric',
      input: value,
      message: `Expected an integer count of minor units, received ${JSON.stringify(value)}`,
    });
  }
  return ok(BigInt(value));
}

/* ── Money level ─────────────────────────────────────────────────────────── */

/** True for a well-formed ISO 4217 alphabetic code: exactly three A-Z. */
export function isValidCurrencyCode(value: string): boolean {
  return CURRENCY_PATTERN.test(value);
}

/**
 * Build a `Money`.
 *
 * A lowercase code is rejected rather than upper-cased. Silently normalizing
 * `"php"` would hide a column-mapping bug in an import; failing loudly surfaces
 * it at the boundary where it can still be fixed.
 */
export function money(amount: Minor, currency: string): Money {
  if (!isValidCurrencyCode(currency)) {
    throw new ValidationError(
      `Currency must be a three-letter uppercase ISO 4217 code, received ${JSON.stringify(currency)}`,
      {
        details: [
          {
            field: 'currency',
            code: 'INVALID_ISO_4217',
            expected: 'three uppercase letters, e.g. PHP',
            actual: currency,
          },
        ],
      },
    );
  }
  return { amount, currency };
}

export function isSameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}

/** Throws `CurrencyMismatchError` unless both values share a currency. */
export function assertSameCurrency(a: Money, b: Money): void {
  if (!isSameCurrency(a, b)) {
    throw new CurrencyMismatchError(
      `Cannot combine ${a.currency} with ${b.currency}; there is no conversion in v1`,
      {
        details: [
          {
            field: 'currency',
            code: 'CURRENCY_MISMATCH',
            expected: a.currency,
            actual: b.currency,
          },
        ],
      },
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function negateMoney(a: Money): Money {
  return { amount: -a.amount, currency: a.currency };
}

export function absMoney(a: Money): Money {
  return { amount: absMinor(a.amount), currency: a.currency };
}

export function isZeroMoney(a: Money): boolean {
  return a.amount === 0n;
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return compareMinor(a.amount, b.amount);
}

/** `allocate`, preserving the currency on every part. */
export function allocateMoney(total: Money, weights: readonly number[]): Money[] {
  return allocate(total.amount, weights).map((amount) => ({ amount, currency: total.currency }));
}

/**
 * Render for humans, with the currency code appended: `"-450.00 PHP"`.
 *
 * The code is what distinguishes this from `formatMinor`. For the API
 * boundary use `toJsonMinor` and send the currency as its own field.
 */
export function formatMoney(value: Money, options: MinorFormatOptions): string {
  return `${formatMinor(value.amount, options)} ${value.currency}`;
}
