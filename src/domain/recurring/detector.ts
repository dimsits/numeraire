/**
 * Recurring-series detection — ARCHITECTURE.MD §6.2, §7.6; Phase 8 task 8.7.
 *
 * DEV_PIPELINE.MD calls this "the one genuinely hard pure function here", and
 * the reason is that real subscription data is messy in specific ways: the
 * billing day drifts, months have different lengths, a charge is occasionally
 * skipped or retried, and prices go up mid-history. A detector tuned on an
 * evenly-spaced synthetic series looks perfect and then finds nothing.
 *
 * Design notes worth knowing before reading the code:
 *
 * - **Everything is integer arithmetic** except the final confidence score,
 *   which is a probability rather than money.
 * - **Medians, not means**, throughout. One skipped month is a 61-day gap; a
 *   mean would drag the inferred cadence with it, a median ignores it.
 * - **There is no notion of "now".** The result is fully determined by the
 *   observations, so the detector takes no clock and no `asOf`. A series last
 *   seen six months ago reports a `nextExpectedAt` in the past, which is
 *   *informative* — Phase 8's job decides whether that means inactive.
 */
import { CurrencyMismatchError, ValidationError } from '@/domain/errors.js';
import { addDays, addMonths, compareCalendarDate, dayOf, daysBetween } from '@/domain/calendar.js';
import { absMinor } from '@/domain/money/money.js';
import type { CalendarDate } from '@/domain/calendar.js';
import type { Minor, Money } from '@/domain/money/money.js';

/** §7.6 `cadence`. */
export const CADENCES = [
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
  'irregular',
] as const;
export type Cadence = (typeof CADENCES)[number];

/**
 * Inclusive day-delta windows per cadence.
 *
 * Wide enough to absorb weekend shifts and month-length variation (a "monthly"
 * charge is 28-31 days apart, and a retry can push it a day or two), narrow
 * enough that adjacent cadences cannot be confused.
 */
export const CADENCE_DAY_RANGES: ReadonlyMap<
  Exclude<Cadence, 'irregular'>,
  readonly [number, number]
> = new Map([
  ['weekly', [6, 8]],
  ['biweekly', [13, 16]],
  ['monthly', [27, 34]],
  ['quarterly', [86, 96]],
  ['semiannual', [175, 190]],
  ['annual', [355, 375]],
]);

/** How many periods a cadence advances by, in months. `null` for day-based ones. */
const CADENCE_MONTH_STEP: ReadonlyMap<Cadence, number> = new Map([
  ['monthly', 1],
  ['quarterly', 3],
  ['semiannual', 6],
  ['annual', 12],
]);

const CADENCE_DAY_STEP: ReadonlyMap<Cadence, number> = new Map([
  ['weekly', 7],
  ['biweekly', 14],
]);

/**
 * Fewest occurrences that can establish a series.
 *
 * Four, giving three intervals — enough for a median to mean something. Three
 * occurrences give two intervals, where a single coincidence is half the
 * evidence. Phase 8 requires detection from six occurrences, so this leaves
 * headroom.
 */
export const DEFAULT_MIN_OCCURRENCES = 4;

/** §7.6 `amount_tolerance_bps` default: plus or minus 10%. */
export const DEFAULT_AMOUNT_TOLERANCE_BPS = 1000;

/** Day-axis slack when deciding whether a gap fits the inferred cadence. */
const INTERVAL_TOLERANCE_PERCENT = 15;
const MIN_INTERVAL_TOLERANCE_DAYS = 2;

/** Occurrences past which more evidence stops raising confidence. */
const CONFIDENCE_SAMPLE_CEILING = 12;

/** An irregular series cannot be more than half-believed, whatever else fits. */
const IRREGULAR_CONFIDENCE_CEILING = 0.5;

export interface RecurringObservation {
  readonly transactionId: string;
  readonly bookedAt: CalendarDate;
  readonly amount: Money;
}

export interface DetectRecurringOptions {
  readonly minOccurrences?: number | undefined;
  readonly amountToleranceBps?: number | undefined;
}

export interface RecurringDetection {
  readonly cadence: Cadence;
  /** The amount currently expected — post-change, if the price moved. */
  readonly expectedAmount: Money;
  readonly amountToleranceBps: number;
  /** Median billing day, for monthly and longer cadences. */
  readonly expectedDayOfMonth: number | null;
  /** [0, 1], to three decimal places (§7.6 stores `numeric(4,3)`). */
  readonly detectionConfidence: number;
  readonly firstSeenAt: CalendarDate;
  readonly lastSeenAt: CalendarDate;
  /** One period after `lastSeenAt`; `null` when the cadence is irregular. */
  readonly nextExpectedAt: CalendarDate | null;
  readonly occurrenceCount: number;
  /** Periods the cadence predicts but no observation covers. */
  readonly skippedPeriods: number;
  /** Date the amount changed, when a mid-history price change is detected. */
  readonly priceChangedAt: CalendarDate | null;
  readonly medianIntervalDays: number;
}

/** Median of a number list. Even lengths take the lower of the two middles. */
function medianNumber(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor((sorted.length - 1) / 2);
  return sorted[middle] ?? 0;
}

/** Median of a bigint list. Even lengths average the two middles, truncating. */
function medianMinor(values: readonly Minor[]): Minor {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const size = sorted.length;
  if (size === 0) return 0n;
  if (size % 2 === 1) return sorted[(size - 1) / 2] ?? 0n;
  const lower = sorted[size / 2 - 1] ?? 0n;
  const upper = sorted[size / 2] ?? 0n;
  return (lower + upper) / 2n;
}

/** Nearest integer to `value / divisor`, without floating point. */
function roundedDivide(value: number, divisor: number): number {
  return Math.floor((2 * value + divisor) / (2 * divisor));
}

/** Which cadence a median interval falls into. */
export function classifyCadence(medianIntervalDays: number): Cadence {
  for (const [cadence, [low, high]] of CADENCE_DAY_RANGES) {
    if (medianIntervalDays >= low && medianIntervalDays <= high) return cadence;
  }
  return 'irregular';
}

/** One period on from `date`, per the cadence. `null` when irregular. */
function advanceOnePeriod(
  date: CalendarDate,
  cadence: Cadence,
  expectedDayOfMonth: number | null,
): CalendarDate | null {
  const dayStep = CADENCE_DAY_STEP.get(cadence);
  if (dayStep !== undefined) return addDays(date, dayStep);

  const monthStep = CADENCE_MONTH_STEP.get(cadence);
  // `expectedDayOfMonth` is computed for exactly the month-based cadences, so
  // inside this branch it is always present; the guard is a type narrowing, not
  // a case that occurs.
  if (monthStep !== undefined && expectedDayOfMonth !== null) {
    return addMonths(date, monthStep, expectedDayOfMonth);
  }
  return null;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer, received ${String(value)}`, {
      details: [{ field, code: 'OUT_OF_RANGE', expected: '>= 1', actual: String(value) }],
    });
  }
}

/** Total absolute deviation of `values` from their own median. */
function totalDeviation(values: readonly Minor[]): Minor {
  const median = medianMinor(values);
  return values.reduce<Minor>((sum, value) => sum + absMinor(value - median), 0n);
}

/** Neither side of a price change can be a single charge; one is a one-off. */
const MIN_PRICE_SEGMENT = 2;

/**
 * Index at which the amount changed, or `null` if it never did.
 *
 * Picks the split that best explains the amounts — the one minimising total
 * within-segment deviation — then accepts it only if the two segments actually
 * differ by more than the amount tolerance. A series with no price change has
 * no split that beats not splitting, so this reports `null` for ordinary
 * usage-driven variation such as a utility bill.
 *
 * Ties resolve to the earliest split, so the result is deterministic.
 */
function findPriceChangeIndex(amounts: readonly Minor[], toleranceBps: number): number | null {
  if (amounts.length < MIN_PRICE_SEGMENT * 2) return null;

  let bestCost = totalDeviation(amounts);
  let bestIndex: number | null = null;
  for (let split = MIN_PRICE_SEGMENT; split <= amounts.length - MIN_PRICE_SEGMENT; split += 1) {
    const cost = totalDeviation(amounts.slice(0, split)) + totalDeviation(amounts.slice(split));
    if (cost < bestCost) {
      bestCost = cost;
      bestIndex = split;
    }
  }
  if (bestIndex === null) return null;

  const before = medianMinor(amounts.slice(0, bestIndex));
  const after = medianMinor(amounts.slice(bestIndex));
  const tolerance = (absMinor(after) * BigInt(toleranceBps)) / 10_000n;
  return absMinor(before - after) > tolerance ? bestIndex : null;
}

/**
 * Infer a recurring series from a merchant's observations.
 *
 * Returns `null` when there is not enough evidence — fewer than
 * `minOccurrences` distinct occurrences. A series that *is* established but
 * whose spacing fits no cadence comes back with `cadence: 'irregular'` rather
 * than `null`: §7.6's enum has that member, so it is a result, not a failure.
 *
 * Throws `CurrencyMismatchError` if the observations are not all in one
 * currency, which would mean the caller grouped them wrongly.
 */
export function detectRecurring(
  observations: readonly RecurringObservation[],
  options: DetectRecurringOptions = {},
): RecurringDetection | null {
  const minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const amountToleranceBps = options.amountToleranceBps ?? DEFAULT_AMOUNT_TOLERANCE_BPS;
  assertPositiveInteger(minOccurrences, 'minOccurrences');
  if (!Number.isInteger(amountToleranceBps) || amountToleranceBps < 0) {
    throw new ValidationError(
      `amountToleranceBps must be a non-negative integer, received ${String(amountToleranceBps)}`,
      {
        details: [
          { field: 'amountToleranceBps', code: 'OUT_OF_RANGE', actual: String(amountToleranceBps) },
        ],
      },
    );
  }

  // Dedupe by transaction id, then order deterministically. Sorting by date
  // *and* id means a shuffled input produces an identical result.
  const unique = new Map<string, RecurringObservation>();
  for (const observation of observations) {
    if (!unique.has(observation.transactionId)) unique.set(observation.transactionId, observation);
  }
  const sorted = [...unique.values()].sort(
    (a, b) =>
      compareCalendarDate(a.bookedAt, b.bookedAt) || a.transactionId.localeCompare(b.transactionId),
  );

  if (sorted.length === 0) return null;

  const currency = sorted[0]?.amount.currency ?? '';
  for (const observation of sorted) {
    if (observation.amount.currency !== currency) {
      throw new CurrencyMismatchError(
        `Observations mix ${currency} and ${observation.amount.currency}; group a series by account before detecting`,
        {
          details: [
            {
              field: 'observations',
              code: 'CURRENCY_MISMATCH',
              expected: currency,
              actual: observation.amount.currency,
            },
          ],
        },
      );
    }
  }

  if (sorted.length < minOccurrences) return null;

  const dates = sorted.map((observation) => observation.bookedAt);
  const amounts = sorted.map((observation) => observation.amount.amount);

  // ── Cadence ────────────────────────────────────────────────────────────
  const intervals: number[] = [];
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1];
    const current = dates[index];
    if (previous === undefined || current === undefined) continue;
    intervals.push(daysBetween(previous, current));
  }

  const medianIntervalDays = medianNumber(intervals);
  const cadence = classifyCadence(medianIntervalDays);

  // ── Regularity, and periods the series skipped ─────────────────────────
  const intervalTolerance = Math.max(
    MIN_INTERVAL_TOLERANCE_DAYS,
    Math.floor((medianIntervalDays * INTERVAL_TOLERANCE_PERCENT) / 100),
  );

  let regularIntervals = 0;
  let skippedPeriods = 0;
  for (const interval of intervals) {
    if (medianIntervalDays <= 0) continue;
    const periods = roundedDivide(interval, medianIntervalDays);
    if (periods >= 1 && Math.abs(interval - periods * medianIntervalDays) <= intervalTolerance) {
      regularIntervals += 1;
      // A 61-day gap in a 30-day series is one occurrence that never arrived,
      // not evidence against the cadence.
      skippedPeriods += periods - 1;
    }
  }
  const regularityScore = intervals.length === 0 ? 0 : regularIntervals / intervals.length;

  // ── Amounts, and mid-history price changes ─────────────────────────────
  // A price change is a *structural* property of the series: it splits the
  // amounts into two contiguous blocks, each internally consistent. Detecting
  // it as "outliers against the overall median" fails exactly when the change
  // is most obvious — with an even 3/3 split the median lands halfway between
  // the two prices, every deviation is identical, and nothing looks anomalous.
  // Worse, the reported amount is then the midpoint: a price that was never
  // charged. Finding the best split point instead has no such blind spot.
  const changeIndex =
    cadence === 'irregular' ? null : findPriceChangeIndex(amounts, amountToleranceBps);

  const trailingAmounts = changeIndex === null ? amounts : amounts.slice(changeIndex);
  const expectedMinor = medianMinor(trailingAmounts);
  const expectedTolerance = (absMinor(expectedMinor) * BigInt(amountToleranceBps)) / 10_000n;
  const withinTolerance = trailingAmounts.filter(
    (amount) => absMinor(amount - expectedMinor) <= expectedTolerance,
  ).length;
  const amountStabilityScore =
    trailingAmounts.length === 0 ? 0 : withinTolerance / trailingAmounts.length;

  // ── Expected billing day, for month-based cadences ─────────────────────
  const expectedDayOfMonth = CADENCE_MONTH_STEP.has(cadence)
    ? medianNumber(dates.map((date) => dayOf(date)))
    : null;

  // ── Confidence ─────────────────────────────────────────────────────────
  const sampleScore = Math.min(1, sorted.length / CONFIDENCE_SAMPLE_CEILING);
  const rawConfidence = 0.5 * regularityScore + 0.3 * amountStabilityScore + 0.2 * sampleScore;
  const capped =
    cadence === 'irregular' ? Math.min(rawConfidence, IRREGULAR_CONFIDENCE_CEILING) : rawConfidence;
  const detectionConfidence = Math.round(capped * 1000) / 1000;

  const firstSeenAt = dates[0];
  const lastSeenAt = dates[dates.length - 1];
  if (firstSeenAt === undefined || lastSeenAt === undefined) return null;

  return {
    cadence,
    expectedAmount: { amount: expectedMinor, currency },
    amountToleranceBps,
    expectedDayOfMonth,
    detectionConfidence,
    firstSeenAt,
    lastSeenAt,
    nextExpectedAt: advanceOnePeriod(lastSeenAt, cadence, expectedDayOfMonth),
    occurrenceCount: sorted.length,
    skippedPeriods,
    priceChangedAt: changeIndex === null ? null : (dates[changeIndex] ?? null),
    medianIntervalDays,
  };
}
