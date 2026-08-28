/**
 * Transaction invariants — ARCHITECTURE.MD §6.3, §7.2, §7.4, ADR-001.
 *
 * Three concerns, all pure:
 *
 *   1. **Sign normalization.** Institutions disagree about which direction is
 *      negative. This module converts whatever arrived into the one internal
 *      convention: outflow negative, inflow positive.
 *   2. **The split invariant.** Split lines must sum to the parent amount.
 *      This is the system's central invariant (ADR-001), enforced here and
 *      again by a deferred constraint trigger in Postgres (§7.4).
 *   3. **The status lifecycle.** Which transitions the categorization pipeline
 *      is allowed to make.
 *
 * `src/domain/ledger/ledger.test.ts` is the specification for all three and was
 * written first — see the header of the sign table there.
 */
import {
  InvalidStatusTransitionError,
  InvariantError,
  SplitImbalanceError,
} from '@/domain/errors.js';
import { signOfMinor, toJsonMinor } from '@/domain/money/money.js';
import type { Minor } from '@/domain/money/money.js';

/** §7.2 `account_kind`. */
export const ACCOUNT_KINDS = [
  'checking',
  'savings',
  'credit_card',
  'cash',
  'investment',
  'loan',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** §7.4 `transaction_status`. */
export const TRANSACTION_STATUSES = [
  'pending_categorization',
  'needs_review',
  'categorized',
  'excluded',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** §7.4 `categorization_source`. */
export const CATEGORIZATION_SOURCES = [
  'manual',
  'rule',
  'ai',
  'recurring_series',
  'import_default',
] as const;
export type CategorizationSource = (typeof CATEGORIZATION_SOURCES)[number];

/** Which way money moved, derived from the normalized sign. */
export type Direction = 'outflow' | 'inflow';

/**
 * How the source institution expressed the sign.
 *
 * This is an explicit parameter rather than something inferred from the account
 * kind, and that is the whole design. §6.3 says a card purchase is "normalized
 * at import **despite issuer sign**" — issuer sign varies, and hard-coding
 * "credit_card implies invert" silently corrupts an export that is already
 * signed the way we want. The kind supplies a *default* (see
 * `defaultSourceConvention`); the caller can always override it once the real
 * shape of a bank's export is known.
 */
export type SourceSignConvention = 'debit_negative' | 'debit_positive';

/** Liability accounts: a charge increases what is owed. */
const LIABILITY_KINDS: ReadonlySet<AccountKind> = new Set<AccountKind>(['credit_card', 'loan']);

export function isLiabilityKind(kind: AccountKind): boolean {
  return LIABILITY_KINDS.has(kind);
}

/**
 * The convention a given account kind usually arrives in.
 *
 * Asset accounts export spending as negative; issuers of liability accounts
 * typically export a charge as positive, because it increases the balance owed.
 */
export function defaultSourceConvention(kind: AccountKind): SourceSignConvention {
  return isLiabilityKind(kind) ? 'debit_positive' : 'debit_negative';
}

/** A transaction amount of zero is meaningless. Mirrors the `tx_amount_nonzero` check. */
export function assertNonZeroAmount(amount: Minor): void {
  if (amount === 0n) {
    throw new InvariantError('A transaction amount must not be zero', {
      details: [
        { field: 'amount', code: 'ZERO_AMOUNT', expected: 'a non-zero amount', actual: '0' },
      ],
    });
  }
}

export interface NormalizeSignInput {
  readonly kind: AccountKind;
  /** The amount exactly as the institution reported it. */
  readonly sourceAmount: Minor;
  /** Defaults to `defaultSourceConvention(kind)`. */
  readonly convention?: SourceSignConvention | undefined;
}

/**
 * Convert an institution-reported amount into the internal convention:
 * **outflow negative, inflow positive**, for every account kind (§6.3).
 */
export function normalizeSign(input: NormalizeSignInput): Minor {
  assertNonZeroAmount(input.sourceAmount);
  const convention = input.convention ?? defaultSourceConvention(input.kind);
  return convention === 'debit_positive' ? -input.sourceAmount : input.sourceAmount;
}

/** Which way a normalized amount moved. Zero is not a direction. */
export function directionOf(amount: Minor): Direction {
  assertNonZeroAmount(amount);
  return amount < 0n ? 'outflow' : 'inflow';
}

/* ── Split lines ─────────────────────────────────────────────────────────── */

export interface SplitLineInput {
  readonly categoryId: string;
  readonly amount: Minor;
}

/** Exact sum of a split set. Zero for an empty set. */
export function splitsTotal(splits: readonly SplitLineInput[]): Minor {
  return splits.reduce<Minor>((total, split) => total + split.amount, 0n);
}

/**
 * The central invariant (ADR-001): split lines decompose a transaction exactly.
 *
 * CLAUDE.md: "Split lines must sum to the parent transaction amount. Never
 * bypass `assertSplitsBalance`."
 *
 * Five rules, each mirroring a constraint Postgres also enforces (§7.4), so the
 * domain layer fails first with a better message. §15.3 explains why both
 * layers exist: application checks give precise, testable errors; the database
 * constraint is the backstop that holds even if this code is bypassed.
 *
 *   | rule                                | database counterpart        |
 *   |-------------------------------------|-----------------------------|
 *   | parent amount is non-zero           | `tx_amount_nonzero`         |
 *   | at least one split                  | `tx_must_have_splits`       |
 *   | every split amount is non-zero      | `splits_amount_nonzero`     |
 *   | every split shares the parent sign  | §6.3 (prose, not a check)   |
 *   | splits sum to the parent amount     | `assert_splits_balance()`   |
 *
 * The sign rule is the one with no database counterpart and the one most worth
 * having: `[+10000, -15000]` against a parent of `-5000` sums correctly while
 * describing something the ledger cannot mean.
 */
export function assertSplitsBalance(
  transactionAmount: Minor,
  splits: readonly SplitLineInput[],
): void {
  assertNonZeroAmount(transactionAmount);

  if (splits.length === 0) {
    throw new SplitImbalanceError('A transaction must have at least one split line', {
      details: [
        {
          field: 'splits',
          code: 'NO_SPLITS',
          expected: 'at least one split line',
          actual: '0',
        },
      ],
    });
  }

  const parentSign = signOfMinor(transactionAmount);

  for (const [index, split] of splits.entries()) {
    if (split.amount === 0n) {
      throw new SplitImbalanceError(
        `Split line ${String(index)} has an amount of zero; every split must move money`,
        {
          details: [
            {
              field: `splits[${String(index)}]`,
              code: 'ZERO_SPLIT_AMOUNT',
              expected: 'a non-zero amount',
              actual: '0',
            },
          ],
        },
      );
    }

    if (signOfMinor(split.amount) !== parentSign) {
      throw new SplitImbalanceError(
        `Split line ${String(index)} has the opposite sign to its transaction; ` +
          'split amounts carry the same sign as their parent (ARCHITECTURE.MD 6.3)',
        {
          details: [
            {
              field: `splits[${String(index)}]`,
              code: 'SIGN_MISMATCH',
              expected: parentSign < 0 ? 'a negative amount' : 'a positive amount',
              actual: toJsonMinor(split.amount),
            },
          ],
        },
      );
    }
  }

  const total = splitsTotal(splits);
  if (total !== transactionAmount) {
    // Wording matches the §13.2 Problem Details example verbatim.
    throw new SplitImbalanceError(
      `Splits total ${toJsonMinor(total)} but transaction amount is ${toJsonMinor(transactionAmount)}`,
      {
        details: [
          {
            field: 'splits',
            code: 'SUM_MISMATCH',
            expected: toJsonMinor(transactionAmount),
            actual: toJsonMinor(total),
          },
        ],
      },
    );
  }
}

/* ── Status lifecycle ────────────────────────────────────────────────────── */

/**
 * The permitted status moves, as data rather than nested conditionals, so a
 * test can assert the table directly and Phase 8's cascade can read it.
 *
 * Two rules worth stating explicitly, because neither is obvious:
 *
 * - **No self-transitions.** Writing a status onto itself is a caller bug, and
 *   allowing it would hide double-application during a Phase 8 rule backfill.
 * - **`excluded` cannot go straight to `needs_review`.** Nothing produces that
 *   move: `needs_review` is exclusively the output of a low-confidence AI
 *   result, which requires re-entering the pipeline at
 *   `pending_categorization` first.
 */
export const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<TransactionStatus, ReadonlySet<TransactionStatus>>
> = {
  pending_categorization: new Set(['needs_review', 'categorized', 'excluded']),
  needs_review: new Set(['pending_categorization', 'categorized', 'excluded']),
  categorized: new Set(['pending_categorization', 'needs_review', 'excluded']),
  excluded: new Set(['pending_categorization', 'categorized']),
};

export function canTransitionStatus(from: TransactionStatus, to: TransactionStatus): boolean {
  // A Record keyed by the union rather than a Map: every status is a key by
  // construction, so there is no absent-key case to defend against at runtime.
  return ALLOWED_STATUS_TRANSITIONS[from].has(to);
}

/** Throws `InvalidStatusTransitionError` unless the lifecycle permits the move. */
export function assertStatusTransition(from: TransactionStatus, to: TransactionStatus): void {
  if (!canTransitionStatus(from, to)) {
    throw new InvalidStatusTransitionError(`A transaction cannot move from ${from} to ${to}`, {
      details: [
        {
          field: 'status',
          code: from === to ? 'SELF_TRANSITION' : 'FORBIDDEN_TRANSITION',
          expected: [...ALLOWED_STATUS_TRANSITIONS[from]].sort().join(', '),
          actual: to,
        },
      ],
    });
  }
}
