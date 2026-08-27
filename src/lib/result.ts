/**
 * `Result<T, E>` — an explicit success/failure value.
 *
 * Used where a failure is an expected outcome that the caller must handle
 * (environment validation, parsing) rather than an exceptional condition.
 * Thrown `AppError` subclasses remain the mechanism for genuine faults; see
 * ARCHITECTURE.md §15.1.
 *
 * The union discriminates on `ok`, so narrowing works without a type guard:
 *
 *   const r = parseEnv(process.env);
 *   if (!r.ok) { report(r.error); return; }
 *   r.value; // Env
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Transform the success value, leaving a failure untouched. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Transform the failure value, leaving a success untouched. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Success value, or `fallback` when the result is a failure. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Success value, or throw. Only for call sites that have already proven the
 * result is `ok` — never as a shortcut around handling the error case.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`unwrap() called on an Err result: ${String(result.error)}`);
  }
  return result.value;
}
