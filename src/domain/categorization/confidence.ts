/**
 * Confidence thresholds and routing — ARCHITECTURE.MD §10.1, §7.4, §16.
 *
 * The §10.1 cascade ends on one decision:
 *
 *   confidence >= 0.85 ?  yes -> apply, status = categorized
 *                         no  -> status = needs_review, surface to the user
 *
 * A `number` is correct here and is not a money path: this is a probability,
 * not an amount. The bans in CLAUDE.md are on float *money* arithmetic.
 */
import { ValidationError } from '@/domain/errors.js';
import type { CategorizationSource } from '@/domain/ledger/transaction.js';

/**
 * The §10.1 threshold.
 *
 * Duplicated here rather than imported from `src/config`: dependency-cruiser
 * forbids `src/domain` -> `src/config`, and rightly — the domain must not read
 * deployment configuration. Services pass `env.AI_CONFIDENCE_THRESHOLD` (§16,
 * same default) explicitly; this constant is the fallback for callers that have
 * no configuration, and the two are asserted equal in the config tests.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

export type CategorizationOutcome = 'categorized' | 'needs_review';

/** Deterministic sources carry no confidence at all (§7.4: `null` for them). */
const DETERMINISTIC_SOURCES: ReadonlySet<CategorizationSource> = new Set<CategorizationSource>([
  'manual',
  'rule',
  'recurring_series',
  'import_default',
]);

export function isDeterministicSource(source: CategorizationSource): boolean {
  return DETERMINISTIC_SOURCES.has(source);
}

/** A finite number in [0, 1]. Rejects NaN and both infinities. */
export function isValidConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function assertValidConfidence(value: number, field = 'confidence'): void {
  if (!isValidConfidence(value)) {
    throw new ValidationError(
      `${field} must be a number between 0 and 1, received ${String(value)}`,
      {
        details: [{ field, code: 'OUT_OF_RANGE', expected: '0..1', actual: String(value) }],
      },
    );
  }
}

/**
 * Route a confidence score to a transaction status.
 *
 * **At exactly the threshold the result is `categorized`** — §10.1 asks
 * `confidence >= 0.85?`, so equality applies rather than reviews.
 */
export function routeByConfidence(
  confidence: number,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): CategorizationOutcome {
  assertValidConfidence(confidence);
  assertValidConfidence(threshold, 'threshold');
  return confidence >= threshold ? 'categorized' : 'needs_review';
}

export interface RouteCategorizationInput {
  readonly source: CategorizationSource;
  /** Required for `ai`; must be `null` for every deterministic source. */
  readonly confidence: number | null;
  readonly threshold?: number | undefined;
}

/**
 * Route by source *and* confidence, enforcing §7.4's "null for deterministic
 * sources" as an invariant rather than leaving it as a schema comment.
 *
 * A rule match is not 87% confident — it either matched or it did not. Allowing
 * a confidence on a deterministic source would let a caller quietly route a
 * rule match to `needs_review`, which would make the deterministic tier
 * non-deterministic and undermine ADR-005.
 */
export function routeCategorization(input: RouteCategorizationInput): CategorizationOutcome {
  if (isDeterministicSource(input.source)) {
    if (input.confidence !== null) {
      throw new ValidationError(
        `Source ${input.source} is deterministic and must not carry a confidence`,
        {
          details: [
            {
              field: 'confidence',
              code: 'UNEXPECTED_CONFIDENCE',
              expected: 'null',
              actual: String(input.confidence),
            },
          ],
        },
      );
    }
    return 'categorized';
  }

  if (input.confidence === null) {
    throw new ValidationError(`Source ${input.source} requires a confidence score`, {
      details: [
        { field: 'confidence', code: 'MISSING_CONFIDENCE', expected: '0..1', actual: 'null' },
      ],
    });
  }

  return routeByConfidence(input.confidence, input.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD);
}
