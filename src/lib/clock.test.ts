import { describe, expect, it } from 'vitest';
import { fixedClock, mutableClock, systemClock } from '@/lib/clock.js';

const EPOCH = new Date('2026-03-12T08:30:00.000Z');

describe('systemClock', () => {
  it('reports the real time', () => {
    const before = Date.now();
    const observed = systemClock.nowMs();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  it('agrees between now() and nowMs()', () => {
    const asDate = systemClock.now().getTime();
    const asMs = systemClock.nowMs();
    expect(Math.abs(asDate - asMs)).toBeLessThan(50);
  });
});

describe('fixedClock', () => {
  it('returns the same instant on every read', () => {
    const clock = fixedClock(EPOCH);
    expect(clock.now().toISOString()).toBe('2026-03-12T08:30:00.000Z');
    expect(clock.nowMs()).toBe(EPOCH.getTime());
    expect(clock.now().getTime()).toBe(clock.now().getTime());
  });

  it('hands out copies, so a caller mutating the Date cannot move the clock', () => {
    const clock = fixedClock(EPOCH);
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it('is unaffected by mutation of the Date it was constructed from', () => {
    const seed = new Date(EPOCH);
    const clock = fixedClock(seed);
    seed.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe('mutableClock', () => {
  it('starts at the supplied instant', () => {
    expect(mutableClock(EPOCH).nowMs()).toBe(EPOCH.getTime());
  });

  it('moves forward by advance()', () => {
    const clock = mutableClock(EPOCH);
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-03-12T08:31:30.000Z');
  });

  it('accumulates successive advances', () => {
    const clock = mutableClock(EPOCH);
    clock.advance(1_000);
    clock.advance(2_000);
    expect(clock.nowMs()).toBe(EPOCH.getTime() + 3_000);
  });

  it('moves backward with a negative advance', () => {
    const clock = mutableClock(EPOCH);
    clock.advance(-1_000);
    expect(clock.nowMs()).toBe(EPOCH.getTime() - 1_000);
  });

  it('jumps to an absolute instant with set()', () => {
    const clock = mutableClock(EPOCH);
    clock.set(new Date('2027-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
