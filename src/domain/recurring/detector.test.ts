import { describe, expect, it } from 'vitest';
import {
  CADENCES,
  CADENCE_DAY_RANGES,
  DEFAULT_AMOUNT_TOLERANCE_BPS,
  DEFAULT_MIN_OCCURRENCES,
  classifyCadence,
  detectRecurring,
} from '@/domain/recurring/detector.js';
import {
  ANNUAL_RENEWAL,
  BIWEEKLY_PAYROLL,
  IRREGULAR_RESTAURANT,
  MONTH_END_SERIES,
  NOISY_UTILITY_BILL,
  QUARTERLY_PREMIUM,
  SUBSCRIPTION_24_MONTHS,
  SUBSCRIPTION_CLEAN_12,
  WEEKLY_GROCERIES,
  observation,
} from '@/domain/recurring/detector.fixtures.js';
import { CurrencyMismatchError, ValidationError } from '@/domain/errors.js';
import { expectThrows } from '@tests/helpers/expect.js';
import type { RecurringDetection } from '@/domain/recurring/detector.js';

/** Detect, asserting a series was found. */
function detect(observations: Parameters<typeof detectRecurring>[0]): RecurringDetection {
  const result = detectRecurring(observations);
  if (result === null) {
    return expect.unreachable('expected a series to be detected');
  }
  return result;
}

describe('the 24-month subscription fixture', () => {
  it('has the shape the trap describes: 23 occurrences, one skip, one price rise', () => {
    expect(SUBSCRIPTION_24_MONTHS).toHaveLength(23);
    const amounts = new Set(SUBSCRIPTION_24_MONTHS.map((o) => o.amount.amount));
    expect(amounts).toEqual(new Set([-99900n, -119900n]));
  });

  const detected = detect(SUBSCRIPTION_24_MONTHS);

  it('infers a monthly cadence despite the gap', () => {
    expect(detected.cadence).toBe('monthly');
    expect(detected.medianIntervalDays).toBeGreaterThanOrEqual(27);
    expect(detected.medianIntervalDays).toBeLessThanOrEqual(34);
  });

  it('reports the CURRENT price, not the historical one', () => {
    // The defect this guards: reporting 999.00 would flag every future correct
    // charge of 1,199.00 as an anomaly.
    expect(detected.expectedAmount).toEqual({ amount: -119900n, currency: 'PHP' });
  });

  it('records when the price changed', () => {
    expect(detected.priceChangedAt).toBe('2025-01-15');
  });

  it('counts the skipped month without treating it as irregularity', () => {
    expect(detected.skippedPeriods).toBe(1);
  });

  it('is confident, because a price change is not disorder', () => {
    expect(detected.detectionConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it('reports the billing day and the next expected date', () => {
    expect(detected.expectedDayOfMonth).toBe(15);
    expect(detected.firstSeenAt).toBe('2024-01-15');
    expect(detected.lastSeenAt).toBe('2025-12-15');
    expect(detected.nextExpectedAt).toBe('2026-01-15');
  });

  it('counts occurrences, not scheduled periods', () => {
    expect(detected.occurrenceCount).toBe(23);
  });
});

describe('a clean series with no skip and no price change', () => {
  const detected = detect(SUBSCRIPTION_CLEAN_12);

  it('is monthly, fully confident, and reports no price change', () => {
    expect(detected.cadence).toBe('monthly');
    expect(detected.detectionConfidence).toBe(1);
    expect(detected.priceChangedAt).toBeNull();
    expect(detected.skippedPeriods).toBe(0);
    expect(detected.expectedAmount.amount).toBe(-99900n);
  });
});

describe('month-end and leap-year behaviour', () => {
  const detected = detect(MONTH_END_SERIES);

  it('reads a 31/29/31/30 billing pattern as monthly, not as drift', () => {
    expect(detected.cadence).toBe('monthly');
    expect(detected.skippedPeriods).toBe(0);
  });

  it('anchors the billing day to the end of the month', () => {
    expect(detected.expectedDayOfMonth).toBe(31);
  });

  it('clamps the next expected date instead of overflowing', () => {
    expect(detected.lastSeenAt).toBe('2024-12-31');
    expect(detected.nextExpectedAt).toBe('2025-01-31');
  });

  it('clamps into February when the anchor day does not exist', () => {
    const throughJanuary = [...MONTH_END_SERIES, observation('me-12', '2025-01-31', -250000n)];
    const next = detect(throughJanuary);
    expect(next.nextExpectedAt).toBe('2025-02-28');
  });

  it('clamps to the leap day in a leap year', () => {
    const intoLeapYear = Array.from({ length: 6 }, (_unused, index) =>
      observation(
        `leap-${String(index)}`,
        ['2023-08-31', '2023-09-30', '2023-10-31', '2023-11-30', '2023-12-31', '2024-01-31'][
          index
        ]!,
        -250000n,
      ),
    );
    expect(detect(intoLeapYear).nextExpectedAt).toBe('2024-02-29');
  });

  it('handles an annual renewal across a leap day', () => {
    const detectedAnnual = detect(ANNUAL_RENEWAL);
    expect(detectedAnnual.cadence).toBe('annual');
    expect(detectedAnnual.lastSeenAt).toBe('2025-02-28');
    expect(detectedAnnual.nextExpectedAt).toBe('2026-02-28');
  });
});

describe('cadence classification', () => {
  it('covers every cadence in the 7.6 enum', () => {
    expect([...CADENCES]).toEqual([
      'weekly',
      'biweekly',
      'monthly',
      'quarterly',
      'semiannual',
      'annual',
      'irregular',
    ]);
    expect([...CADENCE_DAY_RANGES.keys()]).toHaveLength(CADENCES.length - 1);
  });

  it.each([
    // boundary below, at the low edge, at the high edge, boundary above
    [5, 'irregular'],
    [6, 'weekly'],
    [8, 'weekly'],
    [9, 'irregular'],
    [12, 'irregular'],
    [13, 'biweekly'],
    [16, 'biweekly'],
    [17, 'irregular'],
    [26, 'irregular'],
    [27, 'monthly'],
    [30, 'monthly'],
    [34, 'monthly'],
    [35, 'irregular'],
    [85, 'irregular'],
    [86, 'quarterly'],
    [96, 'quarterly'],
    [97, 'irregular'],
    [174, 'irregular'],
    [175, 'semiannual'],
    [190, 'semiannual'],
    [191, 'irregular'],
    [354, 'irregular'],
    [355, 'annual'],
    [365, 'annual'],
    [375, 'annual'],
    [376, 'irregular'],
    [0, 'irregular'],
  ])('an interval of %i days is %s', (days, cadence) => {
    expect(classifyCadence(days)).toBe(cadence);
  });

  it.each([
    ['weekly', WEEKLY_GROCERIES],
    ['biweekly', BIWEEKLY_PAYROLL],
    ['quarterly', QUARTERLY_PREMIUM],
    ['annual', ANNUAL_RENEWAL],
    ['monthly', SUBSCRIPTION_CLEAN_12],
  ] as const)('detects a %s series end to end', (cadence, fixture) => {
    expect(detect(fixture).cadence).toBe(cadence);
  });

  it('advances a weekly series by seven days', () => {
    const detected = detect(WEEKLY_GROCERIES);
    expect(detected.lastSeenAt).toBe('2026-02-02');
    expect(detected.nextExpectedAt).toBe('2026-02-09');
    expect(detected.expectedDayOfMonth).toBeNull();
  });

  it('advances a biweekly series by fourteen days', () => {
    const detected = detect(BIWEEKLY_PAYROLL);
    expect(detected.lastSeenAt).toBe('2026-03-13');
    expect(detected.nextExpectedAt).toBe('2026-03-27');
    expect(detected.expectedDayOfMonth).toBeNull();
  });

  it('advances a quarterly series by three months', () => {
    const detected = detect(QUARTERLY_PREMIUM);
    expect(detected.nextExpectedAt).toBe('2026-04-10');
    expect(detected.expectedDayOfMonth).toBe(10);
  });
});

describe('noisy amounts', () => {
  const detected = detect(NOISY_UTILITY_BILL);

  it('still detects a monthly series when the amount moves with usage', () => {
    expect(detected.cadence).toBe('monthly');
    expect(detected.detectionConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it('reports a representative amount rather than the latest one', () => {
    expect(detected.expectedAmount.amount).toBeLessThan(-176000n);
    expect(detected.expectedAmount.amount).toBeGreaterThan(-196000n);
  });

  it('does not mistake ordinary variation for a price change', () => {
    expect(detected.priceChangedAt).toBeNull();
  });

  it('lowers confidence when the amounts exceed the tolerance', () => {
    const wild = [
      observation('w-0', '2024-01-08', -100000n),
      observation('w-1', '2024-02-08', -900000n),
      observation('w-2', '2024-03-08', -150000n),
      observation('w-3', '2024-04-08', -820000n),
      observation('w-4', '2024-05-08', -110000n),
      observation('w-5', '2024-06-08', -780000n),
    ];
    expect(detect(wild).detectionConfidence).toBeLessThan(
      detect(NOISY_UTILITY_BILL).detectionConfidence,
    );
  });

  it('honours a tightened tolerance', () => {
    const tight = detectRecurring(NOISY_UTILITY_BILL, { amountToleranceBps: 1 });
    expect(tight?.amountToleranceBps).toBe(1);
    expect(tight?.detectionConfidence).toBeLessThan(detected.detectionConfidence);
  });
});

describe('insufficient samples', () => {
  it.each([0, 1, 2, 3])('returns null for %i observations', (count) => {
    expect(detectRecurring(SUBSCRIPTION_CLEAN_12.slice(0, count))).toBeNull();
  });

  it('detects at exactly the minimum', () => {
    expect(DEFAULT_MIN_OCCURRENCES).toBe(4);
    expect(detectRecurring(SUBSCRIPTION_CLEAN_12.slice(0, 4))).not.toBeNull();
  });

  it('honours a raised minimum', () => {
    expect(detectRecurring(SUBSCRIPTION_CLEAN_12.slice(0, 5), { minOccurrences: 6 })).toBeNull();
    expect(
      detectRecurring(SUBSCRIPTION_CLEAN_12.slice(0, 6), { minOccurrences: 6 }),
    ).not.toBeNull();
  });

  it('finds a monthly charge from six occurrences with one price change', () => {
    // The Phase 8 exit criterion, asserted at the domain level.
    const six = [
      observation('p-0', '2025-01-05', -50000n),
      observation('p-1', '2025-02-05', -50000n),
      observation('p-2', '2025-03-05', -50000n),
      observation('p-3', '2025-04-05', -65000n),
      observation('p-4', '2025-05-05', -65000n),
      observation('p-5', '2025-06-05', -65000n),
    ];
    const detected = detect(six);
    expect(detected.cadence).toBe('monthly');
    expect(detected.expectedAmount.amount).toBe(-65000n);
    expect(detected.priceChangedAt).toBe('2025-04-05');
  });

  it.each([0, -1, 1.5])('rejects a minOccurrences of %s', (minOccurrences) => {
    expectThrows(ValidationError, () => detectRecurring(SUBSCRIPTION_CLEAN_12, { minOccurrences }));
  });

  it.each([-1, 1.5])('rejects an amountToleranceBps of %s', (amountToleranceBps) => {
    expectThrows(ValidationError, () =>
      detectRecurring(SUBSCRIPTION_CLEAN_12, { amountToleranceBps }),
    );
  });
});

describe('duplicate and out-of-order input', () => {
  it('produces an identical result from shuffled input', () => {
    const shuffled = [...SUBSCRIPTION_24_MONTHS].reverse();
    expect(detect(shuffled)).toEqual(detect(SUBSCRIPTION_24_MONTHS));
  });

  it('is stable across several different orderings', () => {
    const baseline = detect(SUBSCRIPTION_24_MONTHS);
    const rotated = [...SUBSCRIPTION_24_MONTHS.slice(7), ...SUBSCRIPTION_24_MONTHS.slice(0, 7)];
    const interleaved = [
      ...SUBSCRIPTION_24_MONTHS.filter((_unused, index) => index % 2 === 0),
      ...SUBSCRIPTION_24_MONTHS.filter((_unused, index) => index % 2 === 1),
    ];
    expect(detect(rotated)).toEqual(baseline);
    expect(detect(interleaved)).toEqual(baseline);
  });

  it('dedupes repeated transaction ids', () => {
    const withDuplicates = [...SUBSCRIPTION_CLEAN_12, ...SUBSCRIPTION_CLEAN_12];
    expect(detect(withDuplicates).occurrenceCount).toBe(SUBSCRIPTION_CLEAN_12.length);
    expect(detect(withDuplicates)).toEqual(detect(SUBSCRIPTION_CLEAN_12));
  });

  it('keeps two genuinely distinct charges on the same day', () => {
    const sameDay = [...SUBSCRIPTION_CLEAN_12, observation('extra', '2024-06-15', -99900n)];
    expect(detect(sameDay).occurrenceCount).toBe(SUBSCRIPTION_CLEAN_12.length + 1);
  });

  it('is deterministic across repeated calls', () => {
    expect(detect(SUBSCRIPTION_24_MONTHS)).toEqual(detect(SUBSCRIPTION_24_MONTHS));
  });
});

describe('irregular series', () => {
  const detected = detect(IRREGULAR_RESTAURANT);

  it('classifies ad-hoc visits as irregular', () => {
    expect(detected.cadence).toBe('irregular');
  });

  it('offers no next expected date', () => {
    expect(detected.nextExpectedAt).toBeNull();
  });

  it('offers no expected billing day', () => {
    expect(detected.expectedDayOfMonth).toBeNull();
  });

  it('caps confidence at one half, however well the amounts happen to fit', () => {
    expect(detected.detectionConfidence).toBeLessThanOrEqual(0.5);
  });

  it('returns a detection rather than null, because 7.6 has an irregular member', () => {
    expect(detectRecurring(IRREGULAR_RESTAURANT)).not.toBeNull();
  });
});

describe('currency consistency', () => {
  it('rejects a series that mixes currencies', () => {
    const mixed = [
      ...SUBSCRIPTION_CLEAN_12.slice(0, 5),
      observation('usd', '2024-06-15', -99900n, 'USD'),
    ];
    const error = expectThrows(CurrencyMismatchError, () => detectRecurring(mixed));
    expect(error.details?.[0]?.expected).toBe('PHP');
    expect(error.details?.[0]?.actual).toBe('USD');
  });

  it('carries the currency onto the expected amount', () => {
    expect(detect(SUBSCRIPTION_CLEAN_12).expectedAmount.currency).toBe('PHP');
  });
});

describe('defaults match the 7.6 schema', () => {
  it('uses a plus-or-minus 10% amount tolerance', () => {
    expect(DEFAULT_AMOUNT_TOLERANCE_BPS).toBe(1000);
    expect(detect(SUBSCRIPTION_CLEAN_12).amountToleranceBps).toBe(1000);
  });
});

describe('skipped occurrences', () => {
  it('counts a single missed period', () => {
    expect(detect(SUBSCRIPTION_24_MONTHS).skippedPeriods).toBe(1);
  });

  it('counts two consecutive missed periods as two', () => {
    const withGap = SUBSCRIPTION_CLEAN_12.filter((_unused, index) => index !== 4 && index !== 5);
    expect(detect(withGap).skippedPeriods).toBe(2);
  });

  it('counts separate gaps independently', () => {
    const withGaps = SUBSCRIPTION_CLEAN_12.filter((_unused, index) => index !== 3 && index !== 8);
    expect(detect(withGaps).skippedPeriods).toBe(2);
  });

  it('does not let a skip alone make a series irregular', () => {
    const withGap = SUBSCRIPTION_CLEAN_12.filter((_unused, index) => index !== 4);
    const detected = detect(withGap);
    expect(detected.cadence).toBe('monthly');
    expect(detected.detectionConfidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('degenerate inputs', () => {
  it('treats a series of same-day charges as irregular rather than dividing by zero', () => {
    // Every interval is 0, so the median interval is 0. Nothing may divide by it.
    const sameDay = Array.from({ length: 5 }, (_unused, index) =>
      observation(`sd-${String(index)}`, '2026-03-12', -10000n),
    );
    const detected = detect(sameDay);
    expect(detected.medianIntervalDays).toBe(0);
    expect(detected.cadence).toBe('irregular');
    expect(detected.nextExpectedAt).toBeNull();
    expect(detected.skippedPeriods).toBe(0);
  });

  it('does not look for a price change in a series too short to have one', () => {
    // Both sides of a change need at least two charges, so a 2-observation
    // series can never report one however different the amounts are.
    const two = [
      observation('t-0', '2026-01-05', -10000n),
      observation('t-1', '2026-02-05', -90000n),
    ];
    const detected = detectRecurring(two, { minOccurrences: 2 });
    expect(detected).not.toBeNull();
    expect(detected?.priceChangedAt).toBeNull();
  });

  it('needs two charges on each side before calling it a price change', () => {
    const threeThenOne = [
      observation('q-0', '2026-01-05', -10000n),
      observation('q-1', '2026-02-05', -10000n),
      observation('q-2', '2026-03-05', -10000n),
      observation('q-3', '2026-04-05', -90000n),
    ];
    expect(detect(threeThenOne).priceChangedAt).toBeNull();

    const threeThenTwo = [...threeThenOne, observation('q-4', '2026-05-05', -90000n)];
    expect(detect(threeThenTwo).priceChangedAt).toBe('2026-04-05');
  });

  it('reports the later price when a change splits the series evenly', () => {
    // The case that broke an earlier median-outlier implementation: with an
    // even split the overall median sits halfway between the two prices, every
    // deviation is identical, and the "expected" amount became a midpoint that
    // was never actually charged.
    const evenSplit = [
      observation('e-0', '2026-01-05', -50000n),
      observation('e-1', '2026-02-05', -50000n),
      observation('e-2', '2026-03-05', -65000n),
      observation('e-3', '2026-04-05', -65000n),
    ];
    const detected = detect(evenSplit);
    expect(detected.expectedAmount.amount).toBe(-65000n);
    expect(detected.expectedAmount.amount).not.toBe(-57500n); // the midpoint
    expect(detected.priceChangedAt).toBe('2026-03-05');
  });
});
