/**
 * Transfer pairing — ARCHITECTURE.MD §6.2, §7.4; DEV_PIPELINE.MD Phase 8 task 8.2.
 *
 * A transfer is two transactions in **different** accounts, with **opposite
 * signs** and (usually) equal magnitude, close together in time. §6.2 explains
 * why this matters more than it looks:
 *
 *   > Transfers are excluded from all spending aggregates. Without this, moving
 *   > $2,000 from checking to savings would appear as $2,000 of expenditure,
 *   > which is the single most common defect in naive finance trackers.
 *
 * Two entry points, deliberately:
 *
 *   - `evaluateTransferPair` returns a `Result`. Phase 8's detection heuristic
 *     scans candidate pairs and needs a *reason* for a near-miss so it can
 *     route the uncertain ones to review rather than auto-linking them. The
 *     Phase 8 trap is explicit that this heuristic "will produce false
 *     positives"; a rejection code is what lets the caller be careful.
 *   - `assertTransferPair` throws. `POST /transactions/:id/transfer` (§13.1) is
 *     a user asserting the link exists, so a failure there is an error.
 *
 * Dates are `CalendarDate`, not `Date`: §7.4 stores `booked_at` as SQL `DATE`
 * precisely so a transaction on the 31st cannot drift to the 30th, and a
 * day-gap window computed through a timezone would inherit that bug.
 */
import { calendarDateOrThrow, compareCalendarDate, daysBetween } from '@/domain/calendar.js';
import { TransferPairError } from '@/domain/errors.js';
import { absMinor, isSameCurrency, signOfMinor } from '@/domain/money/money.js';
import { err, ok } from '@/lib/result.js';
import type { CalendarDate } from '@/domain/calendar.js';
import type { Minor, Money } from '@/domain/money/money.js';
import type { Result } from '@/lib/result.js';

export interface TransferLeg {
  readonly transactionId: string;
  readonly accountId: string;
  /** Already normalized to the internal convention (§6.3). */
  readonly amount: Money;
  readonly bookedAt: CalendarDate;
}

export interface TransferPairOptions {
  /** Largest permitted gap in whole days, inclusive. */
  readonly maxDayGap: number;
  /** Permitted magnitude difference, in basis points of the larger leg. */
  readonly amountToleranceBps: number;
}

/**
 * Deliberately tight.
 *
 * `maxDayGap: 3` covers weekend and holiday settlement lag without linking
 * two unrelated equal-and-opposite amounts a month apart. `amountToleranceBps:
 * 0` requires an exact magnitude match, because §6.2 says "(usually) equal
 * magnitude" and the Phase 8 trap warns that a loose heuristic produces false
 * positives. The knob exists for callers who know their data needs it; the
 * default does not spend that risk on their behalf.
 */
export const DEFAULT_TRANSFER_PAIR_OPTIONS: TransferPairOptions = {
  maxDayGap: 3,
  amountToleranceBps: 0,
};

export type TransferRejection =
  | { readonly code: 'same_transaction'; readonly transactionId: string }
  | { readonly code: 'same_account'; readonly accountId: string }
  | { readonly code: 'currency_mismatch'; readonly left: string; readonly right: string }
  | { readonly code: 'zero_amount' }
  | { readonly code: 'same_sign'; readonly sign: -1 | 1 }
  | {
      readonly code: 'magnitude_mismatch';
      readonly delta: string;
      readonly allowed: string;
    }
  | {
      readonly code: 'date_gap_exceeded';
      readonly dayGap: number;
      readonly maxDayGap: number;
    };

export interface TransferPair {
  /** The leg money left — the negative one. */
  readonly from: TransferLeg;
  /** The leg money arrived in — the positive one. */
  readonly to: TransferLeg;
  /** Whole days between the two booking dates, always non-negative. */
  readonly dayGap: number;
  /** How far the two magnitudes differ. Zero for an exact match. */
  readonly magnitudeDelta: Minor;
}

/** Human-readable reason, used as the thrown message. */
function describeRejection(rejection: TransferRejection): string {
  switch (rejection.code) {
    case 'same_transaction':
      return `A transaction cannot transfer to itself (${rejection.transactionId})`;
    case 'same_account':
      return `Both legs are in account ${rejection.accountId}; a transfer moves money between different accounts`;
    case 'currency_mismatch':
      return `Cannot pair ${rejection.left} with ${rejection.right}; cross-currency transfers are not supported in v1`;
    case 'zero_amount':
      return 'A transfer leg must not have a zero amount';
    case 'same_sign':
      return `Both legs are ${rejection.sign < 0 ? 'negative' : 'positive'}; transfer legs have opposite signs`;
    case 'magnitude_mismatch':
      return `Leg magnitudes differ by ${rejection.delta}, which exceeds the permitted ${rejection.allowed}`;
    case 'date_gap_exceeded':
      return `Legs are ${String(rejection.dayGap)} days apart, which exceeds the permitted ${String(rejection.maxDayGap)}`;
  }
}

/**
 * Test two transactions against the transfer-pair rules.
 *
 * Checks run in a fixed order — identity, account, currency, amount, sign,
 * magnitude, date — so the reported reason is stable and testable rather than
 * dependent on which check happened to run first.
 */
export function evaluateTransferPair(
  a: TransferLeg,
  b: TransferLeg,
  options: Partial<TransferPairOptions> = {},
): Result<TransferPair, TransferRejection> {
  const { maxDayGap, amountToleranceBps } = { ...DEFAULT_TRANSFER_PAIR_OPTIONS, ...options };

  if (a.transactionId === b.transactionId) {
    return err({ code: 'same_transaction', transactionId: a.transactionId });
  }
  if (a.accountId === b.accountId) {
    return err({ code: 'same_account', accountId: a.accountId });
  }
  if (!isSameCurrency(a.amount, b.amount)) {
    return err({
      code: 'currency_mismatch',
      left: a.amount.currency,
      right: b.amount.currency,
    });
  }

  const signA = signOfMinor(a.amount.amount);
  const signB = signOfMinor(b.amount.amount);
  if (signA === 0 || signB === 0) {
    return err({ code: 'zero_amount' });
  }
  if (signA === signB) {
    return err({ code: 'same_sign', sign: signA });
  }

  const magnitudeA = absMinor(a.amount.amount);
  const magnitudeB = absMinor(b.amount.amount);
  const larger = magnitudeA > magnitudeB ? magnitudeA : magnitudeB;
  // Basis points in bigint: truncating division keeps the allowance
  // conservative, and no ratio is ever held as a float.
  const allowed = (larger * BigInt(amountToleranceBps)) / 10_000n;
  const delta = magnitudeA > magnitudeB ? magnitudeA - magnitudeB : magnitudeB - magnitudeA;
  if (delta > allowed) {
    return err({
      code: 'magnitude_mismatch',
      delta: delta.toString(),
      allowed: allowed.toString(),
    });
  }

  const dayGap = Math.abs(daysBetween(a.bookedAt, b.bookedAt));
  if (dayGap > maxDayGap) {
    return err({ code: 'date_gap_exceeded', dayGap, maxDayGap });
  }

  // Orientation is derived from the signs, so the result is identical whichever
  // order the caller passed the legs in.
  const from = signA < 0 ? a : b;
  const to = signA < 0 ? b : a;
  return ok({ from, to, dayGap, magnitudeDelta: delta });
}

/** `evaluateTransferPair`, throwing `TransferPairError` instead of returning a reason. */
export function assertTransferPair(
  a: TransferLeg,
  b: TransferLeg,
  options: Partial<TransferPairOptions> = {},
): TransferPair {
  const result = evaluateTransferPair(a, b, options);
  if (!result.ok) {
    throw new TransferPairError(describeRejection(result.error), {
      details: [
        {
          field: 'transfer',
          code: result.error.code.toUpperCase(),
          actual: `${a.transactionId} + ${b.transactionId}`,
        },
      ],
    });
  }
  return result.value;
}

/** Convenience for tests and fixtures: build a leg without ceremony. */
export function transferLeg(input: {
  readonly transactionId: string;
  readonly accountId: string;
  readonly amount: Money;
  readonly bookedAt: string;
}): TransferLeg {
  return {
    transactionId: input.transactionId,
    accountId: input.accountId,
    amount: input.amount,
    bookedAt: calendarDateOrThrow(input.bookedAt),
  };
}

/** Chronological order of the two legs, for callers rendering a pair. */
export function orderLegsByDate(pair: TransferPair): readonly [TransferLeg, TransferLeg] {
  return compareCalendarDate(pair.from.bookedAt, pair.to.bookedAt) <= 0
    ? [pair.from, pair.to]
    : [pair.to, pair.from];
}
