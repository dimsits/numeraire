/**
 * Realistic observation series for the recurring detector.
 *
 * DEV_PIPELINE.MD Phase 1, traps: "Give it real fixture data — 24 months of a
 * subscription charge with one price increase and one skipped month — rather
 * than a synthetic evenly-spaced series." An evenly-spaced series makes any
 * detector look correct; these are shaped like the data that actually arrives.
 *
 * Colocated under `src/domain/` rather than in `tests/fixtures/`, which is
 * excluded from lint, Prettier, dependency-cruiser and the invariant checker
 * precisely because it holds deliberate violations. These are ordinary typed
 * data and should be held to the same standard as the code they exercise.
 */
import { calendarDateOrThrow } from '@/domain/calendar.js';
import { money } from '@/domain/money/money.js';
import type { RecurringObservation } from '@/domain/recurring/detector.js';

const PHP = 'PHP';

export function observation(
  id: string,
  bookedAt: string,
  amount: bigint,
  currency = PHP,
): RecurringObservation {
  return {
    transactionId: id,
    bookedAt: calendarDateOrThrow(bookedAt),
    amount: money(amount, currency),
  };
}

/** `YYYY-MM-DD` for the given day of a month offset from a base year/month. */
function monthly(baseYear: number, baseMonth: number, offset: number, day: number): string {
  const total = baseYear * 12 + (baseMonth - 1) + offset;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The headline fixture: a streaming subscription billed on the 15th.
 *
 * 24 scheduled months from 2024-01, of which:
 *   - **2024-07 never arrived** (a failed card, a service credit — it happens),
 *     leaving 23 actual observations;
 *   - **the price rose** from 999.00 to 1,199.00 effective 2025-01-15,
 *     splitting the series into 11 old-price and 12 new-price occurrences.
 *
 * A detector that reports 999.00 as the expected amount here is wrong in the
 * way that matters: it would flag every future correct charge as anomalous.
 */
export const SUBSCRIPTION_24_MONTHS: readonly RecurringObservation[] = Array.from(
  { length: 24 },
  (_unused, index) => index,
)
  .filter((index) => index !== 6) // 2024-07 skipped
  .map((index) =>
    observation(
      `sub-${String(index).padStart(2, '0')}`,
      monthly(2024, 1, index, 15),
      index < 12 ? -99900n : -119900n,
    ),
  );

/** The same subscription with no skip and no price change — the clean case. */
export const SUBSCRIPTION_CLEAN_12: readonly RecurringObservation[] = Array.from(
  { length: 12 },
  (_unused, index) => observation(`clean-${String(index)}`, monthly(2024, 1, index, 15), -99900n),
);

/**
 * A gym membership billed on the last day of the month, across a leap year.
 *
 * The billing day is 31, 29, 31, 30, ... — the detector must not conclude the
 * day drifted, and `nextExpectedAt` must clamp rather than overflow.
 */
export const MONTH_END_SERIES: readonly RecurringObservation[] = [
  observation('me-0', '2024-01-31', -250000n),
  observation('me-1', '2024-02-29', -250000n),
  observation('me-2', '2024-03-31', -250000n),
  observation('me-3', '2024-04-30', -250000n),
  observation('me-4', '2024-05-31', -250000n),
  observation('me-5', '2024-06-30', -250000n),
  observation('me-6', '2024-07-31', -250000n),
  observation('me-7', '2024-08-31', -250000n),
  observation('me-8', '2024-09-30', -250000n),
  observation('me-9', '2024-10-31', -250000n),
  observation('me-10', '2024-11-30', -250000n),
  observation('me-11', '2024-12-31', -250000n),
];

/**
 * A utility bill: monthly, but the amount moves with usage.
 *
 * Amounts vary by roughly plus or minus 8%, inside the §7.6 default tolerance
 * of 1000 bps, so this must still be detected as a stable monthly series.
 */
export const NOISY_UTILITY_BILL: readonly RecurringObservation[] = [
  observation('util-0', '2024-01-08', -184500n),
  observation('util-1', '2024-02-07', -179200n),
  observation('util-2', '2024-03-08', -192300n),
  observation('util-3', '2024-04-09', -176800n),
  observation('util-4', '2024-05-08', -188100n),
  observation('util-5', '2024-06-07', -195400n),
  observation('util-6', '2024-07-08', -181900n),
  observation('util-7', '2024-08-08', -186600n),
];

/** A payroll deposit, every second Friday. */
export const BIWEEKLY_PAYROLL: readonly RecurringObservation[] = [
  observation('pay-0', '2026-01-02', 4500000n),
  observation('pay-1', '2026-01-16', 4500000n),
  observation('pay-2', '2026-01-30', 4500000n),
  observation('pay-3', '2026-02-13', 4500000n),
  observation('pay-4', '2026-02-27', 4500000n),
  observation('pay-5', '2026-03-13', 4500000n),
];

/** A weekly grocery delivery, with the usual day-or-two slippage. */
export const WEEKLY_GROCERIES: readonly RecurringObservation[] = [
  observation('grocery-0', '2026-01-05', -320000n),
  observation('grocery-1', '2026-01-12', -335000n),
  observation('grocery-2', '2026-01-20', -318000n),
  observation('grocery-3', '2026-01-26', -329000n),
  observation('grocery-4', '2026-02-02', -324000n),
];

/** An annual domain renewal across a leap day. */
export const ANNUAL_RENEWAL: readonly RecurringObservation[] = [
  observation('dom-0', '2022-02-28', -75000n),
  observation('dom-1', '2023-02-28', -75000n),
  observation('dom-2', '2024-02-29', -75000n),
  observation('dom-3', '2025-02-28', -75000n),
];

/** A quarterly insurance premium. */
export const QUARTERLY_PREMIUM: readonly RecurringObservation[] = [
  observation('ins-0', '2025-01-10', -1250000n),
  observation('ins-1', '2025-04-10', -1250000n),
  observation('ins-2', '2025-07-10', -1250000n),
  observation('ins-3', '2025-10-10', -1250000n),
  observation('ins-4', '2026-01-10', -1250000n),
];

/** Ad-hoc restaurant visits: same merchant, no cadence at all. */
export const IRREGULAR_RESTAURANT: readonly RecurringObservation[] = [
  observation('rest-0', '2026-01-03', -128000n),
  observation('rest-1', '2026-01-06', -94500n),
  observation('rest-2', '2026-01-24', -215000n),
  observation('rest-3', '2026-02-11', -76000n),
  observation('rest-4', '2026-02-13', -302000n),
  observation('rest-5', '2026-03-29', -110000n),
];
