import { describe, expect, it } from 'vitest';
import {
  MAX_YEAR,
  MIN_YEAR,
  addDays,
  addMonths,
  calendarDate,
  calendarDateOrThrow,
  compareCalendarDate,
  dayOf,
  daysBetween,
  daysInMonth,
  fromEpochDay,
  isLastDayOfMonth,
  isLeapYear,
  monthOf,
  parseCalendarDate,
  toEpochDay,
  yearOf,
} from '@/domain/calendar.js';
import { ValidationError } from '@/domain/errors.js';
import { expectErr, expectOk, expectThrows } from '@tests/helpers/expect.js';
import type { CalendarDate } from '@/domain/calendar.js';

const d = calendarDateOrThrow;

describe('isLeapYear', () => {
  it.each([
    [1900, false], // century, not divisible by 400
    [2000, true], // century, divisible by 400
    [2024, true],
    [2025, false],
    [2026, false],
    [2028, true],
    [2100, false],
    [2400, true],
  ])('%i -> %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });
});

describe('daysInMonth', () => {
  it.each([
    [2026, 1, 31],
    [2026, 2, 28],
    [2024, 2, 29],
    [2000, 2, 29],
    [1900, 2, 28],
    [2026, 4, 30],
    [2026, 12, 31],
  ])('%i-%i has %i days', (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });

  it('rejects a month outside 1-12', () => {
    expect(() => daysInMonth(2026, 13)).toThrow(ValidationError);
    expect(() => daysInMonth(2026, 0)).toThrow(ValidationError);
  });
});

describe('parseCalendarDate', () => {
  it.each([
    '2026-03-12',
    '2024-02-29', // real leap day
    '2026-01-01',
    '2026-12-31',
    '0001-01-01',
    '9999-12-31',
  ])('accepts %s', (input) => {
    expect(expectOk(parseCalendarDate(input))).toBe(input);
  });

  it.each([
    ['2026-02-29', 'out-of-range'], // 2026 is not a leap year
    ['1900-02-29', 'out-of-range'], // century non-leap
    ['2026-13-01', 'out-of-range'],
    ['2026-00-10', 'out-of-range'],
    ['2026-04-31', 'out-of-range'], // April has 30 days
    ['2026-03-00', 'out-of-range'],
    ['0000-01-01', 'out-of-range'], // year 0 excluded
    ['2026-1-1', 'malformed'], // single-digit parts
    ['26-03-12', 'malformed'], // two-digit year
    ['20260312', 'malformed'], // no separators
    ['2026/03/12', 'malformed'], // wrong separator
    ['2026-03-12T00:00:00Z', 'malformed'], // time component
    [' 2026-03-12', 'malformed'], // leading whitespace
    ['2026-03-12 ', 'malformed'], // trailing whitespace
    ['', 'malformed'],
    ['not a date', 'malformed'],
    ['2026-03-12-01', 'malformed'],
  ])('rejects %s as %s', (input, code) => {
    expect(expectErr(parseCalendarDate(input)).code).toBe(code);
  });
});

describe('calendarDateOrThrow', () => {
  it('returns the date on success', () => {
    expect(calendarDateOrThrow('2026-03-12')).toBe('2026-03-12');
  });

  it('throws ValidationError with field-level detail on failure', () => {
    const error = expectThrows(ValidationError, () => calendarDateOrThrow('2026-02-29'));
    expect(error.details).toEqual([
      { field: 'date', code: 'DATE_OUT_OF_RANGE', expected: 'YYYY-MM-DD', actual: '2026-02-29' },
    ]);
  });

  it('distinguishes malformed input from an unreal date', () => {
    const malformed = expectThrows(ValidationError, () => calendarDateOrThrow('2026/03/12'));
    expect(malformed.details?.[0]?.code).toBe('MALFORMED_DATE');

    const unreal = expectThrows(ValidationError, () => calendarDateOrThrow('2026-02-29'));
    expect(unreal.details?.[0]?.code).toBe('DATE_OUT_OF_RANGE');
  });
});

describe('calendarDate', () => {
  it('zero-pads every component', () => {
    expect(calendarDate(2026, 3, 5)).toBe('2026-03-05');
    expect(calendarDate(7, 1, 1)).toBe('0007-01-01');
  });

  it.each([
    [2026, 2, 29],
    [2026, 13, 1],
    [2026, 0, 1],
    [2026, 4, 31],
    [0, 1, 1],
    [10000, 1, 1],
    [2026.5, 1, 1],
  ])('rejects %i-%i-%i', (year, month, day) => {
    expect(() => calendarDate(year, month, day)).toThrow(ValidationError);
  });
});

describe('component accessors', () => {
  it('reads year, month and day without a Date object', () => {
    const date = d('2026-03-31');
    expect(yearOf(date)).toBe(2026);
    expect(monthOf(date)).toBe(3);
    expect(dayOf(date)).toBe(31);
  });

  it('reports the 31st as the 31st — no timezone drift', () => {
    // The whole reason this module exists (§7.4). A Date-based implementation
    // reports the 30th anywhere west of Greenwich.
    expect(dayOf(d('2026-03-31'))).toBe(31);
    expect(dayOf(d('2026-01-01'))).toBe(1);
    expect(dayOf(d('2026-12-31'))).toBe(31);
  });
});

describe('toEpochDay / fromEpochDay', () => {
  it.each([
    ['1970-01-01', 0],
    ['1970-01-02', 1],
    ['1969-12-31', -1],
    ['2000-01-01', 10957],
    ['2024-02-29', 19782],
    ['2026-03-12', 20524],
  ])('%s <-> %i', (text, epochDay) => {
    expect(toEpochDay(d(text))).toBe(epochDay);
    expect(fromEpochDay(epochDay)).toBe(text);
  });

  it('round-trips every day across a leap year', () => {
    let date = d('2024-01-01');
    for (let i = 0; i < 366; i += 1) {
      expect(fromEpochDay(toEpochDay(date))).toBe(date);
      date = addDays(date, 1);
    }
    expect(date).toBe('2025-01-01');
  });

  it('round-trips across century boundaries and the epoch', () => {
    for (const text of [
      '0001-01-01',
      '1899-12-31',
      '1900-03-01',
      '1969-12-31',
      '1970-01-01',
      '2000-02-29',
      '2100-03-01',
      '9999-12-31',
    ]) {
      expect(fromEpochDay(toEpochDay(d(text)))).toBe(text);
    }
  });

  it('rejects a non-integer epoch day', () => {
    expect(() => fromEpochDay(1.5)).toThrow(ValidationError);
    expect(() => fromEpochDay(Number.NaN)).toThrow(ValidationError);
  });

  it('rejects an epoch day outside the supported year range', () => {
    expect(() => fromEpochDay(toEpochDay(d('9999-12-31')) + 1)).toThrow(ValidationError);
    expect(() => fromEpochDay(toEpochDay(d('0001-01-01')) - 1)).toThrow(ValidationError);
  });
});

describe('daysBetween', () => {
  it.each([
    ['2026-03-12', '2026-03-12', 0],
    ['2026-03-12', '2026-03-13', 1],
    ['2026-03-13', '2026-03-12', -1],
    ['2026-03-01', '2026-04-01', 31],
    ['2026-02-01', '2026-03-01', 28],
    ['2024-02-01', '2024-03-01', 29], // leap February
    ['2026-01-01', '2027-01-01', 365],
    ['2024-01-01', '2025-01-01', 366], // leap year
    ['2026-12-31', '2027-01-01', 1], // year boundary
  ])('%s -> %s is %i days', (from, to, expected) => {
    expect(daysBetween(d(from), d(to))).toBe(expected);
  });

  it('is antisymmetric', () => {
    expect(daysBetween(d('2026-03-12'), d('2026-09-01'))).toBe(
      -daysBetween(d('2026-09-01'), d('2026-03-12')),
    );
  });

  it('spans the leap day exactly once', () => {
    expect(daysBetween(d('2024-02-28'), d('2024-03-01'))).toBe(2);
    expect(daysBetween(d('2026-02-28'), d('2026-03-01'))).toBe(1);
  });
});

describe('addDays', () => {
  it.each([
    ['2026-03-12', 1, '2026-03-13'],
    ['2026-03-12', -1, '2026-03-11'],
    ['2026-03-12', 0, '2026-03-12'],
    ['2026-01-31', 1, '2026-02-01'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2024-02-29', 1, '2024-03-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-03-12', 7, '2026-03-19'],
    ['2026-03-12', 14, '2026-03-26'],
    ['2026-03-12', 365, '2027-03-12'],
  ])('%s + %i days -> %s', (from, days, expected) => {
    expect(addDays(d(from), days)).toBe(expected);
  });

  it('rejects a fractional offset', () => {
    expect(() => addDays(d('2026-03-12'), 1.5)).toThrow(ValidationError);
  });
});

describe('addMonths', () => {
  it.each([
    ['2026-03-12', 1, '2026-04-12'],
    ['2026-03-12', -1, '2026-02-12'],
    ['2026-03-12', 0, '2026-03-12'],
    ['2026-03-12', 12, '2027-03-12'],
    ['2026-12-01', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-01'],
    ['2026-03-12', 3, '2026-06-12'],
    ['2026-03-12', 6, '2026-09-12'],
  ])('%s + %i months -> %s', (from, months, expected) => {
    expect(addMonths(d(from), months)).toBe(expected);
  });

  it.each([
    // The month-end contract: clamp to the target month's length.
    ['2026-01-31', 1, '2026-02-28'],
    ['2024-01-31', 1, '2024-02-29'], // leap February
    ['2026-01-31', 3, '2026-04-30'], // April has 30 days
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-05-31', 1, '2026-06-30'],
    ['2024-02-29', 12, '2025-02-28'], // leap day, one year on
    ['2024-02-29', 48, '2028-02-29'], // leap day, four years on
    ['2026-08-31', 6, '2027-02-28'],
  ])('clamps %s + %i months -> %s', (from, months, expected) => {
    expect(addMonths(d(from), months)).toBe(expected);
  });

  it('anchors to an explicit day of month, recovering from an earlier clamp', () => {
    // A series billed on the 31st clamps to 2026-02-28 in February. Advancing
    // from there without an anchor would stick at the 28th forever.
    const clamped = addMonths(d('2026-01-31'), 1);
    expect(clamped).toBe('2026-02-28');
    expect(addMonths(clamped, 1)).toBe('2026-03-28'); // unanchored: drifts
    expect(addMonths(clamped, 1, 31)).toBe('2026-03-31'); // anchored: recovers
  });

  it('rejects a fractional month offset', () => {
    expect(() => addMonths(d('2026-03-12'), 1.5)).toThrow(ValidationError);
  });

  it.each([0, 32, -1, 1.5])('rejects day-of-month anchor %s', (anchor) => {
    expect(() => addMonths(d('2026-03-12'), 1, anchor)).toThrow(ValidationError);
  });

  it('rejects a result outside the supported year range', () => {
    expect(() => addMonths(d('9999-12-31'), 1)).toThrow(ValidationError);
    expect(() => addMonths(d('0001-01-01'), -1)).toThrow(ValidationError);
  });
});

describe('compareCalendarDate', () => {
  it.each([
    ['2026-03-12', '2026-03-13', -1],
    ['2026-03-13', '2026-03-12', 1],
    ['2026-03-12', '2026-03-12', 0],
    ['2025-12-31', '2026-01-01', -1],
    ['2026-01-01', '2025-12-31', 1],
  ])('%s vs %s -> %i', (a, b, expected) => {
    expect(compareCalendarDate(d(a), d(b))).toBe(expected);
  });

  it('sorts a shuffled series chronologically', () => {
    const dates: CalendarDate[] = ['2026-03-12', '2024-02-29', '2026-01-01', '2025-12-31'].map(d);
    expect([...dates].sort(compareCalendarDate)).toEqual([
      '2024-02-29',
      '2025-12-31',
      '2026-01-01',
      '2026-03-12',
    ]);
  });
});

describe('isLastDayOfMonth', () => {
  it.each([
    ['2026-01-31', true],
    ['2026-01-30', false],
    ['2026-02-28', true],
    ['2024-02-28', false], // leap year: the 29th is last
    ['2024-02-29', true],
    ['2026-04-30', true],
    ['2026-04-29', false],
    ['2026-12-31', true],
  ])('%s -> %s', (date, expected) => {
    expect(isLastDayOfMonth(d(date))).toBe(expected);
  });
});

describe('supported range constants', () => {
  it('bounds years to the four-digit format', () => {
    expect(MIN_YEAR).toBe(1);
    expect(MAX_YEAR).toBe(9999);
  });
});
