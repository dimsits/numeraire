/**
 * Domain error taxonomy — ARCHITECTURE.MD §15.1.
 *
 * CLAUDE.md: "Errors are `AppError` subclasses. Never throw strings or bare
 * `Error`." This module is the whole vocabulary. Every throw in `src/domain`
 * uses one of these, and ESLint's `only-throw-error` rule makes a bare string
 * a build failure.
 *
 * `type` holds a **slug**, not a URI. ARCHITECTURE.MD §13.2 renders errors as
 * RFC 9457 Problem Details with `"type": "https://numeraire.local/errors/
 * split-imbalance"`, but the base URI is deployment configuration. The domain
 * layer must not know a hostname (dependency-cruiser forbids
 * `src/domain` -> `src/config`), so it owns the stable identifier and the
 * Phase 3 error handler prefixes it.
 *
 * `status` mirrors §15.1 exactly. `isOperational` distinguishes an expected
 * condition from a bug: operational errors are safe to surface to the caller,
 * non-operational ones log with a full stack and return a generic 500 (§15.2).
 */

/**
 * One field-level problem, matching the `errors[]` element in the §13.2
 * response shape. `expected` and `actual` are strings rather than numbers
 * because monetary values serialize as strings of minor units (§6.4) — a
 * `bigint` here would throw in `JSON.stringify`.
 */
export interface ErrorDetail {
  readonly field: string;
  readonly code: string;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
}

export interface AppErrorOptions {
  /** Underlying cause, preserved on the standard `Error.cause` property. */
  readonly cause?: unknown;
  /** Field-level detail rendered into the §13.2 `errors[]` array. */
  readonly details?: readonly ErrorDetail[] | undefined;
}

/**
 * Base class for every error this application raises deliberately.
 *
 * Abstract members rather than constructor parameters: the status and type of
 * a `NotFoundError` are properties of the class, not of the call site, so they
 * cannot be passed wrongly.
 */
export abstract class AppError extends Error {
  /** HTTP status this error maps to (§15.1). */
  abstract readonly status: number;
  /** Stable identifier, used as the RFC 9457 `type` slug (§13.2). */
  abstract readonly type: string;
  /** Expected condition (true) versus a bug (false). */
  abstract readonly isOperational: boolean;

  readonly details: readonly ErrorDetail[] | undefined;

  constructor(message: string, options?: AppErrorOptions) {
    // Only pass ErrorOptions when there is a cause: `{ cause: undefined }`
    // would define an own `cause` property holding undefined, which reads as
    // "a cause was supplied and it was nothing".
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    // `new.target` is the concrete subclass, so every instance reports its own
    // name rather than inheriting "Error".
    this.name = new.target.name;
    this.details = options?.details;
  }
}

/* ── 4xx — operational, expected, safe to surface ────────────────────────── */

/** Malformed input: shape, type, range, or format (§15.3 Zod layer). */
export class ValidationError extends AppError {
  readonly status = 400;
  readonly type = 'validation-failed';
  readonly isOperational = true;
}

/** No credentials, or credentials that did not authenticate. */
export class UnauthorizedError extends AppError {
  readonly status = 401;
  readonly type = 'unauthorized';
  readonly isOperational = true;
}

/** Authenticated, but not permitted to touch this resource. */
export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly type = 'forbidden';
  readonly isOperational = true;
}

/** The resource does not exist, or does not belong to this user (ADR-009). */
export class NotFoundError extends AppError {
  readonly status = 404;
  readonly type = 'not-found';
  readonly isOperational = true;
}

/** State collision: a duplicate import row, a reused refresh token (§15.2). */
export class ConflictError extends AppError {
  readonly status = 409;
  readonly type = 'conflict';
  readonly isOperational = true;
}

/**
 * A business invariant was violated (§15.3 domain-assertion layer).
 *
 * The subclasses below are the specific invariants this domain enforces. They
 * exist so §13.2 can render a distinct `type` per failure rather than one
 * opaque 422 — the response example in that section names
 * `errors/split-imbalance` directly.
 */
export class InvariantError extends AppError {
  readonly status = 422;
  // Annotated `string` rather than left to infer the literal type: the
  // subclasses below override it, and a literal type here would make every
  // override a type error.
  readonly type: string = 'invariant-violated';
  readonly isOperational = true;
}

/** Too many requests from this caller. */
export class RateLimitError extends AppError {
  readonly status = 429;
  readonly type = 'rate-limited';
  readonly isOperational = true;
}

/* ── Domain invariants — ARCHITECTURE.MD §6.3, §6.4, §7.4 ────────────────── */

/**
 * Split lines do not satisfy the central invariant (ADR-001): they are empty,
 * contain a zero amount, carry a sign opposed to the parent, or do not sum to
 * the parent transaction amount.
 */
export class SplitImbalanceError extends InvariantError {
  override readonly type = 'split-imbalance';
}

/** An operation combined two `Money` values in different currencies. */
export class CurrencyMismatchError extends InvariantError {
  override readonly type = 'currency-mismatch';
}

/** Two transactions were offered as a transfer pair but do not qualify (§6.2). */
export class TransferPairError extends InvariantError {
  override readonly type = 'transfer-pair-invalid';
}

/** A transaction status change that the lifecycle does not allow (§7.4). */
export class InvalidStatusTransitionError extends InvariantError {
  override readonly type = 'invalid-status-transition';
}

/* ── 5xx / cost control — infrastructure ─────────────────────────────────── */

/**
 * The per-user AI spend ceiling is exhausted (§12.6).
 *
 * 429 rather than 402: the request is not permanently refused, it is refused
 * until the budget window rolls over.
 */
export class BudgetExceededError extends AppError {
  readonly status = 429;
  readonly type = 'ai-budget-exceeded';
  readonly isOperational = true;
}

/**
 * An upstream provider failed — an LLM timeout, a 5xx, a transport error.
 *
 * Operational: a model returning 503 is an expected condition on a network
 * boundary, not a defect in this system. It is safe to surface and worth
 * retrying, which is exactly what `isOperational` is consulted for.
 */
export class ProviderError extends AppError {
  readonly status = 502;
  readonly type = 'provider-failure';
  readonly isOperational = true;
}

/**
 * Narrow `unknown` to `AppError` — for `catch` blocks, where TypeScript's
 * `useUnknownInCatchVariables` gives no type at all.
 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
