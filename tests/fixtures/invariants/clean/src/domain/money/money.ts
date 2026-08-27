// Clean domain module: bigint minor units, injected clock, no console.
import type { Clock } from '../../lib/clock.js';

export function addMinor(a: bigint, b: bigint): bigint {
  return a + b;
}

export function stampedAt(clock: Clock): Date {
  return clock.now();
}
