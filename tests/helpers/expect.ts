/**
 * Assertion helpers that make a skipped assertion impossible.
 *
 * The pattern these replace looks correct and is not:
 *
 *   try { addMoney(a, foreign); }
 *   catch (caught) { if (caught instanceof CurrencyMismatchError) { expect(...) } }
 *
 * If the call stops throwing, the `catch` never runs, no assertion executes,
 * and the test passes green while asserting nothing. That was verified by
 * mutation, not inferred: disabling `assertSameCurrency` entirely left the test
 * passing. DEV_PIPELINE.MD §1.4 check 2 — "are the tests testing behaviour, or
 * asserting the implementation back at itself?" — is exactly this failure.
 *
 * Each helper below asserts the branch it expects and *returns the value*, so
 * the assertion lives in straight-line code and cannot be stepped over by
 * control flow. Use these rather than `try`/`catch` or `if (result.ok)` in any
 * test that inspects a thrown error or a `Result`.
 */
import { expect } from 'vitest';
import type { Result } from '@/lib/result.js';

/**
 * A class reference for `expectThrows`. `abstract new` so an abstract base —
 * `AppError`, `InvariantError` — can be named as the expected type.
 */
type ErrorClass<E extends Error> = (abstract new (...args: never[]) => E) & {
  readonly name: string;
};

/** Best-effort rendering for a failure message. Never throws, even on a bigint. */
function render(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Assert that `fn` throws an instance of `ErrorType`, and return it so its
 * `status`, `type`, `details` and `cause` can be asserted directly.
 *
 * Fails when nothing is thrown *and* when something of the wrong type is.
 */
export function expectThrows<E extends Error>(ErrorType: ErrorClass<E>, fn: () => unknown): E {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error: unknown) {
    threw = true;
    caught = error;
  }

  if (!threw) {
    return expect.unreachable(
      `Expected ${ErrorType.name} to be thrown, but the call returned normally`,
    );
  }

  expect(caught).toBeInstanceOf(ErrorType);
  // Single narrowing cast, immediately justified by the assertion above.
  return caught as E;
}

/** Assert the `Result` succeeded and return its value. */
export function expectOk<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  return expect.unreachable(`Expected Ok, received Err: ${render(result.error)}`);
}

/** Assert the `Result` failed and return its error. */
export function expectErr<T, E>(result: Result<T, E>): E {
  if (!result.ok) return result.error;
  return expect.unreachable(`Expected Err, received Ok: ${render(result.value)}`);
}
