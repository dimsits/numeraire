/**
 * Injectable time source.
 *
 * CLAUDE.md: time comes from the injected `Clock`, never `new Date()` in the
 * domain or service layers. `scripts/check-invariants.ts` enforces that for
 * `src/domain/**`; this module is the single sanctioned place where the real
 * system clock is read.
 */

export interface Clock {
  /** Current instant as a `Date`. */
  now(): Date;
  /** Current instant in epoch milliseconds. */
  nowMs(): number;
}

/** The real clock. Wire this in at composition roots only. */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
  nowMs(): number {
    return Date.now();
  },
};

/** A clock frozen at `instant`. Every read returns the same time. */
export function fixedClock(instant: Date): Clock {
  const ms = instant.getTime();
  return {
    now: () => new Date(ms),
    nowMs: () => ms,
  };
}

export interface MutableClock extends Clock {
  /** Move the clock forward (or backward, with a negative value). */
  advance(milliseconds: number): void;
  /** Jump the clock to an absolute instant. */
  set(instant: Date): void;
}

/**
 * A clock a test can drive by hand — for asserting behaviour across time
 * without `vi.useFakeTimers()` and without real waiting.
 */
export function mutableClock(start: Date): MutableClock {
  let ms = start.getTime();
  return {
    now: () => new Date(ms),
    nowMs: () => ms,
    advance(milliseconds: number): void {
      ms += milliseconds;
    },
    set(instant: Date): void {
      ms = instant.getTime();
    },
  };
}
