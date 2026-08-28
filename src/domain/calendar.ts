/**
 * Calendar-date arithmetic for the domain layer.
 *
 * ARCHITECTURE.MD §7.4 is explicit about why this exists:
 *
 *   > Calendar date as reported by the institution. DATE, not timestamptz —
 *   > a transaction on the 31st must not drift to the 30th under timezone
 *   > conversion.
 *
 * A JavaScript `Date` is an instant, not a date. `new Date('2026-03-31')`
 * parses as UTC midnight and `getDate()` then reports the 30th anywhere west
 * of Greenwich. Every function here therefore works on `YYYY-MM-DD` strings
 * and plain integers, and **no `Date` object is constructed anywhere in this
 * module**. That also satisfies the domain purity rules: ESLint bans
 * zero-argument `Date` construction under `src/domain/`, and
 * `scripts/check-invariants.ts` greps for the same thing independently — which
 * is why this paragraph describes the banned call rather than spelling it.
 *
 * The conversion to and from a day number uses Howard Hinnant's `days_from_civil`
 * algorithm — exact integer arithmetic over the proleptic Gregorian calendar,
 * valid across the whole supported range, with no floating point and no lookup
 * of leap-year exceptions beyond the standard rule.
 */
import { err, ok } from '@/lib/result.js';
import type { Result } from '@/lib/result.js';
import { ValidationError } from '@/domain/errors.js';

/**
 * A calendar date in ISO `YYYY-MM-DD` form, proven to name a real day.
 *
 * Branded so a raw string cannot be passed where a validated date is required:
 * every value of this type has been through `parseCalendarDate` or
 * `calendarDate`.
 */
export type CalendarDate = string & { readonly __brand: 'CalendarDate' };

export type CalendarDateIssue =
  | { readonly code: 'malformed'; readonly input: string; readonly message: string }
  | { readonly code: 'out-of-range'; readonly input: string; readonly message: string };

/** Earliest representable date. Four-digit years only, so year 0 is excluded. */
export const MIN_YEAR = 1;
/** Latest representable date, bounded by the four-digit `YYYY` format. */
export const MAX_YEAR = 9999;

const DAYS_IN_MONTH_COMMON = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Integer division truncating toward zero, matching the reference algorithm. */
function idiv(numerator: number, denominator: number): number {
  return Math.trunc(numerator / denominator);
}

/** The only place a raw string becomes a `CalendarDate`. */
function brand(value: string): CalendarDate {
  return value as CalendarDate;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Gregorian leap-year rule: divisible by 4, except centuries not by 400. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Length of `month` (1-12) in `year`. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  const length = DAYS_IN_MONTH_COMMON[month - 1];
  if (length === undefined) {
    throw new ValidationError(`Month out of range: ${String(month)}`, {
      details: [{ field: 'month', code: 'OUT_OF_RANGE', expected: '1-12', actual: String(month) }],
    });
  }
  return length;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * Parse an ISO `YYYY-MM-DD` string.
 *
 * Strict by design: no two-digit years, no single-digit months, no `2026/03/12`,
 * no time component, no surrounding whitespace. An import that produces any of
 * those has a column-mapping problem (§9.2), and guessing would corrupt the
 * ledger silently — §13.5 lists "date ambiguity corrupts an import" as a
 * standing risk.
 */
export function parseCalendarDate(input: string): Result<CalendarDate, CalendarDateIssue> {
  // `test` plus fixed-offset slices rather than `exec` plus capture groups:
  // under `noUncheckedIndexedAccess` every group reads as `string | undefined`,
  // and the guard for a case the pattern already excludes would be an
  // unreachable branch counting against the domain coverage gate.
  if (!ISO_DATE_PATTERN.test(input)) {
    return err({
      code: 'malformed',
      input,
      message: 'Expected a calendar date in YYYY-MM-DD form',
    });
  }

  const year = Number(input.slice(0, 4));
  const month = Number(input.slice(5, 7));
  const day = Number(input.slice(8, 10));

  if (!isRealDate(year, month, day)) {
    return err({
      code: 'out-of-range',
      input,
      message: `${input} is not a real calendar date`,
    });
  }

  return ok(brand(input));
}

/** `parseCalendarDate`, throwing `ValidationError` instead of returning a failure. */
export function calendarDateOrThrow(input: string): CalendarDate {
  const parsed = parseCalendarDate(input);
  if (!parsed.ok) {
    throw new ValidationError(parsed.error.message, {
      details: [
        {
          field: 'date',
          code: parsed.error.code === 'malformed' ? 'MALFORMED_DATE' : 'DATE_OUT_OF_RANGE',
          expected: 'YYYY-MM-DD',
          actual: parsed.error.input,
        },
      ],
    });
  }
  return parsed.value;
}

/** Build a date from its parts. Throws `ValidationError` if they name no real day. */
export function calendarDate(year: number, month: number, day: number): CalendarDate {
  if (!isRealDate(year, month, day)) {
    throw new ValidationError(
      `${String(year)}-${String(month)}-${String(day)} is not a real calendar date`,
      {
        details: [
          {
            field: 'date',
            code: 'DATE_OUT_OF_RANGE',
            expected: `year ${String(MIN_YEAR)}-${String(MAX_YEAR)}, real month and day`,
            actual: `${String(year)}-${String(month)}-${String(day)}`,
          },
        ],
      },
    );
  }
  return brand(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`);
}

export function yearOf(date: CalendarDate): number {
  return Number(date.slice(0, 4));
}

/** Month of the year, 1-12. */
export function monthOf(date: CalendarDate): number {
  return Number(date.slice(5, 7));
}

/** Day of the month, 1-31. */
export function dayOf(date: CalendarDate): number {
  return Number(date.slice(8, 10));
}

/**
 * Days since 1970-01-01, as an integer. Negative before the epoch.
 *
 * Howard Hinnant's `days_from_civil`. Shifting the year start to March makes
 * the leap day the last day of the year, which removes every special case from
 * the day-of-year computation.
 */
export function toEpochDay(date: CalendarDate): number {
  const month = monthOf(date);
  const day = dayOf(date);
  const year = yearOf(date) - (month <= 2 ? 1 : 0);

  const era = idiv(year >= 0 ? year : year - 399, 400);
  const yearOfEra = year - era * 400; // [0, 399]
  const dayOfYear = idiv(153 * (month + (month > 2 ? -3 : 9)) + 2, 5) + day - 1; // [0, 365]
  const dayOfEra = yearOfEra * 365 + idiv(yearOfEra, 4) - idiv(yearOfEra, 100) + dayOfYear;

  return era * 146097 + dayOfEra - 719468;
}

/** Inverse of `toEpochDay`. Throws `ValidationError` outside the supported range. */
export function fromEpochDay(epochDay: number): CalendarDate {
  if (!Number.isInteger(epochDay)) {
    throw new ValidationError(`Epoch day must be an integer, received ${String(epochDay)}`, {
      details: [{ field: 'epochDay', code: 'NOT_AN_INTEGER', actual: String(epochDay) }],
    });
  }

  const shifted = epochDay + 719468;
  const era = idiv(shifted >= 0 ? shifted : shifted - 146096, 146097);
  const dayOfEra = shifted - era * 146097; // [0, 146096]
  const yearOfEra = idiv(
    dayOfEra - idiv(dayOfEra, 1460) + idiv(dayOfEra, 36524) - idiv(dayOfEra, 146096),
    365,
  ); // [0, 399]
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + idiv(yearOfEra, 4) - idiv(yearOfEra, 100));
  const monthPrime = idiv(5 * dayOfYear + 2, 153); // [0, 11], March-based
  const day = dayOfYear - idiv(153 * monthPrime + 2, 5) + 1; // [1, 31]
  const month = monthPrime + (monthPrime < 10 ? 3 : -9); // [1, 12]

  return calendarDate(year + (month <= 2 ? 1 : 0), month, day);
}

/**
 * Whole days from `from` to `to`. Positive when `to` is later, negative when
 * earlier, zero when equal. Exact — there is no hour, so no daylight-saving
 * transition can round it.
 */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** Shift by whole days. Negative `days` moves backwards. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  if (!Number.isInteger(days)) {
    throw new ValidationError(`Day offset must be an integer, received ${String(days)}`, {
      details: [{ field: 'days', code: 'NOT_AN_INTEGER', actual: String(days) }],
    });
  }
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * Shift by whole months, clamping the day to the target month's length.
 *
 * Clamping is the behaviour a subscription actually has: a charge on the 31st
 * bills on the 28th in February and on the 30th in April. `dayOfMonth`
 * overrides the source day, which lets a caller anchor to a series'
 * `expectedDayOfMonth` rather than to whichever day the last occurrence
 * happened to land on after a previous clamp.
 *
 *   addMonths('2026-01-31', 1)               -> '2026-02-28'
 *   addMonths('2024-01-31', 1)               -> '2024-02-29'  (leap year)
 *   addMonths('2024-02-29', 12)              -> '2025-02-28'
 *   addMonths('2026-02-28', 1, 31)           -> '2026-03-31'  (anchored)
 */
export function addMonths(date: CalendarDate, months: number, dayOfMonth?: number): CalendarDate {
  if (!Number.isInteger(months)) {
    throw new ValidationError(`Month offset must be an integer, received ${String(months)}`, {
      details: [{ field: 'months', code: 'NOT_AN_INTEGER', actual: String(months) }],
    });
  }

  const anchorDay = dayOfMonth ?? dayOf(date);
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new ValidationError(`Day of month must be 1-31, received ${String(anchorDay)}`, {
      details: [
        { field: 'dayOfMonth', code: 'OUT_OF_RANGE', expected: '1-31', actual: String(anchorDay) },
      ],
    });
  }

  const totalMonths = yearOf(date) * 12 + (monthOf(date) - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = totalMonths - targetYear * 12 + 1;

  if (targetYear < MIN_YEAR || targetYear > MAX_YEAR) {
    throw new ValidationError(`Resulting year ${String(targetYear)} is out of range`, {
      details: [
        {
          field: 'months',
          code: 'DATE_OUT_OF_RANGE',
          expected: `year ${String(MIN_YEAR)}-${String(MAX_YEAR)}`,
          actual: String(targetYear),
        },
      ],
    });
  }

  return calendarDate(
    targetYear,
    targetMonth,
    Math.min(anchorDay, daysInMonth(targetYear, targetMonth)),
  );
}

/** Chronological ordering. `YYYY-MM-DD` sorts lexicographically, but compare by day for clarity. */
export function compareCalendarDate(a: CalendarDate, b: CalendarDate): -1 | 0 | 1 {
  const left = toEpochDay(a);
  const right = toEpochDay(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** True when `date` is the final day of its month. */
export function isLastDayOfMonth(date: CalendarDate): boolean {
  return dayOf(date) === daysInMonth(yearOf(date), monthOf(date));
}
