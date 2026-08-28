import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KINDS,
  ALLOWED_STATUS_TRANSITIONS,
  CATEGORIZATION_SOURCES,
  TRANSACTION_STATUSES,
  assertNonZeroAmount,
  assertSplitsBalance,
  assertStatusTransition,
  canTransitionStatus,
  defaultSourceConvention,
  directionOf,
  isLiabilityKind,
  normalizeSign,
  splitsTotal,
} from '@/domain/ledger/transaction.js';
import {
  InvalidStatusTransitionError,
  InvariantError,
  SplitImbalanceError,
  TransferPairError,
} from '@/domain/errors.js';
import {
  assertTransferPair,
  evaluateTransferPair,
  orderLegsByDate,
  transferLeg,
} from '@/domain/ledger/transfer.js';
import { money } from '@/domain/money/money.js';
import { expectErr, expectOk, expectThrows } from '@tests/helpers/expect.js';
import type {
  AccountKind,
  Direction,
  SourceSignConvention,
  TransactionStatus,
} from '@/domain/ledger/transaction.js';
import type { TransferLeg } from '@/domain/ledger/transfer.js';
import type { Minor } from '@/domain/money/money.js';

/* ============================================================================
   THE SIGN CONVENTION - ARCHITECTURE.MD 6.3

   This table is the specification, written before the implementation
   (DEV_PIPELINE.MD Phase 1, "the sign-convention test comes first"). Every row
   states its expectation literally rather than deriving it, because a table
   that computes its expectations from the same rule the code uses proves
   nothing.

   DEV_PIPELINE.MD 13.5 names "sign convention implemented backwards for credit
   cards" as the defect that silently poisons every aggregate in the system.
   These 24 rows are what stops it.

   Internal convention, invariant across every account kind:
     outflow (spending) -> NEGATIVE
     inflow  (income)   -> POSITIVE

   The institution's own convention varies, which is why it is an explicit
   parameter rather than something inferred from the kind:
     debit_negative   spending arrives negative (typical asset-account export)
     debit_positive   spending arrives positive (typical issuer export)
   ========================================================================= */

interface SignRow {
  readonly kind: AccountKind;
  readonly convention: SourceSignConvention;
  readonly source: Minor;
  readonly internal: Minor;
  readonly direction: Direction;
}

const OUT = 'outflow';
const IN = 'inflow';

// One row per line is the point of this table: reflowing it into 24 multi-line
// objects destroys the symmetry a reviewer checks against ARCHITECTURE.MD 6.3.
// prettier-ignore
const SIGN_NORMALIZATION: readonly SignRow[] = [
  // -- checking ----------------------------------------------------
  { kind: 'checking', convention: 'debit_negative', source: -45000n, internal: -45000n, direction: OUT },
  { kind: 'checking', convention: 'debit_negative', source:  45000n, internal:  45000n, direction: IN  },
  { kind: 'checking', convention: 'debit_positive', source:  45000n, internal: -45000n, direction: OUT },
  { kind: 'checking', convention: 'debit_positive', source: -45000n, internal:  45000n, direction: IN  },
  // -- savings -----------------------------------------------------
  { kind: 'savings', convention: 'debit_negative', source: -45000n, internal: -45000n, direction: OUT },
  { kind: 'savings', convention: 'debit_negative', source:  45000n, internal:  45000n, direction: IN  },
  { kind: 'savings', convention: 'debit_positive', source:  45000n, internal: -45000n, direction: OUT },
  { kind: 'savings', convention: 'debit_positive', source: -45000n, internal:  45000n, direction: IN  },
  // -- cash --------------------------------------------------------
  { kind: 'cash', convention: 'debit_negative', source: -45000n, internal: -45000n, direction: OUT },
  { kind: 'cash', convention: 'debit_negative', source:  45000n, internal:  45000n, direction: IN  },
  { kind: 'cash', convention: 'debit_positive', source:  45000n, internal: -45000n, direction: OUT },
  { kind: 'cash', convention: 'debit_positive', source: -45000n, internal:  45000n, direction: IN  },
  // -- investment --------------------------------------------------
  { kind: 'investment', convention: 'debit_negative', source: -45000n, internal: -45000n, direction: OUT },
  { kind: 'investment', convention: 'debit_negative', source:  45000n, internal:  45000n, direction: IN  },
  { kind: 'investment', convention: 'debit_positive', source:  45000n, internal: -45000n, direction: OUT },
  { kind: 'investment', convention: 'debit_positive', source: -45000n, internal:  45000n, direction: IN  },
  // -- credit_card (liability) -------------------------------
  // A purchase arrives POSITIVE from the issuer (it increases what is owed)
  // and must be stored NEGATIVE. This is the row 13.5 is about.
  { kind: 'credit_card', convention: 'debit_positive', source:  45000n, internal: -45000n, direction: OUT },
  { kind: 'credit_card', convention: 'debit_positive', source: -45000n, internal:  45000n, direction: IN  },
  // Some issuers export already-signed. The convention says so; the kind cannot.
  { kind: 'credit_card', convention: 'debit_negative', source: -45000n, internal: -45000n, direction: OUT },
  { kind: 'credit_card', convention: 'debit_negative', source:  45000n, internal:  45000n, direction: IN  },
  // -- loan (liability) --------------------------------------
  { kind: 'loan', convention: 'debit_positive', source:  45000n, internal: -45000n, direction: OUT },
  { kind: 'loan', convention: 'debit_positive', source: -45000n, internal:  45000n, direction: IN  },
  { kind: 'loan', convention: 'debit_negative', source: -45000n, internal: -45000n, direction: OUT },
  { kind: 'loan', convention: 'debit_negative', source:  45000n, internal:  45000n, direction: IN  },
];

describe('sign normalization (6.3)', () => {
  it('covers every account kind against both conventions and both source signs', () => {
    expect(SIGN_NORMALIZATION).toHaveLength(ACCOUNT_KINDS.length * 2 * 2);
    expect(new Set(SIGN_NORMALIZATION.map((row) => row.kind))).toEqual(new Set(ACCOUNT_KINDS));
  });

  it.each(
    SIGN_NORMALIZATION.map(
      (row) =>
        [
          `${row.kind} / ${row.convention} / ${String(row.source)} -> ${String(row.internal)} (${row.direction})`,
          row,
        ] as const,
    ),
  )('%s', (_title, row) => {
    const internal = normalizeSign({
      kind: row.kind,
      sourceAmount: row.source,
      convention: row.convention,
    });
    expect(internal).toBe(row.internal);
    expect(directionOf(internal)).toBe(row.direction);
  });

  it.each([
    ['checking', 'debit_negative'],
    ['savings', 'debit_negative'],
    ['cash', 'debit_negative'],
    ['investment', 'debit_negative'],
    ['credit_card', 'debit_positive'],
    ['loan', 'debit_positive'],
  ] as const)('defaults %s to %s', (kind, convention) => {
    expect(defaultSourceConvention(kind)).toBe(convention);
  });

  it.each(ACCOUNT_KINDS)('uses the kind default when no convention is given: %s', (kind) => {
    const explicit = normalizeSign({
      kind,
      sourceAmount: 45000n,
      convention: defaultSourceConvention(kind),
    });
    expect(normalizeSign({ kind, sourceAmount: 45000n })).toBe(explicit);
  });

  it.each([
    ['checking', false],
    ['savings', false],
    ['cash', false],
    ['investment', false],
    ['credit_card', true],
    ['loan', true],
  ] as const)('classifies %s as liability=%s', (kind, expected) => {
    expect(isLiabilityKind(kind)).toBe(expected);
  });

  describe('the two scenarios 6.3 spells out', () => {
    it('normalizes a credit card purchase to negative despite the issuer sign', () => {
      // "Credit card purchase | negative | Normalized at import despite issuer sign"
      expect(normalizeSign({ kind: 'credit_card', sourceAmount: 45000n })).toBe(-45000n);
    });

    it('books a card payment positive on the card and negative on the funding account', () => {
      // "Credit card payment | positive on the card account, negative on the
      //  funding account | Linked as a transfer"
      const onCard = normalizeSign({ kind: 'credit_card', sourceAmount: -50000n });
      const onChecking = normalizeSign({ kind: 'checking', sourceAmount: -50000n });
      expect(onCard).toBe(50000n);
      expect(onChecking).toBe(-50000n);
      // The pair nets to zero, which is what keeps a transfer out of spending.
      expect(onCard + onChecking).toBe(0n);
    });

    it('treats a loan exactly as a credit card', () => {
      // Interest charged increases what is owed; a payment reduces it.
      expect(normalizeSign({ kind: 'loan', sourceAmount: 120000n })).toBe(-120000n);
      expect(normalizeSign({ kind: 'loan', sourceAmount: -500000n })).toBe(500000n);
    });
  });

  it('rejects a zero amount, mirroring the tx_amount_nonzero constraint', () => {
    expectThrows(InvariantError, () => normalizeSign({ kind: 'checking', sourceAmount: 0n }));
    expectThrows(InvariantError, () => directionOf(0n));
    expectThrows(InvariantError, () => {
      assertNonZeroAmount(0n);
    });
  });

  it('accepts any non-zero amount', () => {
    expect(() => {
      assertNonZeroAmount(1n);
    }).not.toThrow();
    expect(() => {
      assertNonZeroAmount(-1n);
    }).not.toThrow();
  });
});

/* ============================================================================
   SPLIT LINES - the central invariant (ADR-001, 7.4)
   ========================================================================= */

const CATEGORY_A = '018f0000-0000-7000-8000-00000000000a';
const CATEGORY_B = '018f0000-0000-7000-8000-00000000000b';
const CATEGORY_C = '018f0000-0000-7000-8000-00000000000c';

describe('assertSplitsBalance (ADR-001)', () => {
  it('accepts a single split equal to the parent', () => {
    expect(() => {
      assertSplitsBalance(-45000n, [{ categoryId: CATEGORY_A, amount: -45000n }]);
    }).not.toThrow();
  });

  it('accepts a three-way split that sums exactly', () => {
    expect(() => {
      assertSplitsBalance(-12000n, [
        { categoryId: CATEGORY_A, amount: -3000n },
        { categoryId: CATEGORY_B, amount: -3000n },
        { categoryId: CATEGORY_C, amount: -6000n },
      ]);
    }).not.toThrow();
  });

  it('accepts an inflow split the same way', () => {
    expect(() => {
      assertSplitsBalance(5000000n, [{ categoryId: CATEGORY_A, amount: 5000000n }]);
    }).not.toThrow();
  });

  it('sums splits without losing a minor unit', () => {
    expect(
      splitsTotal([
        { categoryId: CATEGORY_A, amount: -334n },
        { categoryId: CATEGORY_B, amount: -333n },
        { categoryId: CATEGORY_C, amount: -333n },
      ]),
    ).toBe(-1000n);
  });

  it('sums an empty set to zero', () => {
    expect(splitsTotal([])).toBe(0n);
  });

  it.each([
    ['one minor unit short', -45000n],
    ['one minor unit over', -55000n],
  ])('rejects splits that are %s', (_label, splitAmount) => {
    const error = expectThrows(SplitImbalanceError, () => {
      assertSplitsBalance(-50000n, [{ categoryId: CATEGORY_A, amount: splitAmount }]);
    });
    expect(error.details?.[0]?.code).toBe('SUM_MISMATCH');
  });

  it('reports the totals in the 13.2 message shape', () => {
    // ARCHITECTURE.MD 13.2: "Splits total -45000 but transaction amount is -50000"
    const error = expectThrows(SplitImbalanceError, () => {
      assertSplitsBalance(-50000n, [{ categoryId: CATEGORY_A, amount: -45000n }]);
    });
    expect(error.message).toBe('Splits total -45000 but transaction amount is -50000');
    expect(error.details).toEqual([
      { field: 'splits', code: 'SUM_MISMATCH', expected: '-50000', actual: '-45000' },
    ]);
  });

  it('rejects an empty split set, mirroring tx_must_have_splits', () => {
    const error = expectThrows(SplitImbalanceError, () => {
      assertSplitsBalance(-45000n, []);
    });
    expect(error.details?.[0]?.code).toBe('NO_SPLITS');
  });

  it('rejects a zero-amount split, mirroring splits_amount_nonzero', () => {
    const error = expectThrows(SplitImbalanceError, () => {
      assertSplitsBalance(-45000n, [
        { categoryId: CATEGORY_A, amount: -45000n },
        { categoryId: CATEGORY_B, amount: 0n },
      ]);
    });
    expect(error.details?.[0]?.code).toBe('ZERO_SPLIT_AMOUNT');
    expect(error.details?.[0]?.field).toBe('splits[1]');
  });

  it('rejects an opposite-sign split even when the total is correct', () => {
    // 6.3: "Split line amounts carry the same sign as their parent
    // transaction." [+10000, -15000] sums to -5000 and would pass a naive sum
    // check while representing something the ledger cannot mean.
    const error = expectThrows(SplitImbalanceError, () => {
      assertSplitsBalance(-5000n, [
        { categoryId: CATEGORY_A, amount: 10000n },
        { categoryId: CATEGORY_B, amount: -15000n },
      ]);
    });
    expect(error.details?.[0]?.code).toBe('SIGN_MISMATCH');
    expect(error.details?.[0]?.field).toBe('splits[0]');
  });

  it('rejects an opposite-sign split on an inflow too', () => {
    const error = expectThrows(SplitImbalanceError, () => {
      assertSplitsBalance(5000n, [
        { categoryId: CATEGORY_A, amount: 15000n },
        { categoryId: CATEGORY_B, amount: -10000n },
      ]);
    });
    expect(error.details?.[0]?.code).toBe('SIGN_MISMATCH');
  });

  it('rejects a zero parent amount, mirroring tx_amount_nonzero', () => {
    expectThrows(InvariantError, () => {
      assertSplitsBalance(0n, [{ categoryId: CATEGORY_A, amount: 0n }]);
    });
  });

  it('accepts allocate() output directly, which is the point of allocate', () => {
    const parts = [-334n, -333n, -333n];
    expect(() => {
      assertSplitsBalance(
        -1000n,
        parts.map((amount, index) => ({ categoryId: `cat-${String(index)}`, amount })),
      );
    }).not.toThrow();
  });

  it('holds for amounts beyond 2^53', () => {
    expect(() => {
      assertSplitsBalance(-9007199254740993n, [
        { categoryId: CATEGORY_A, amount: -9007199254740992n },
        { categoryId: CATEGORY_B, amount: -1n },
      ]);
    }).not.toThrow();
  });
});

/* ============================================================================
   STATUS TRANSITIONS - 7.4
   ========================================================================= */

/** Every ordered pair. `true` where the lifecycle permits the move. */
const TRANSITION_MATRIX: readonly (readonly [TransactionStatus, TransactionStatus, boolean])[] = [
  // from pending_categorization
  ['pending_categorization', 'pending_categorization', false],
  ['pending_categorization', 'needs_review', true],
  ['pending_categorization', 'categorized', true],
  ['pending_categorization', 'excluded', true],
  // from needs_review
  ['needs_review', 'pending_categorization', true], // re-queued for the cascade
  ['needs_review', 'needs_review', false],
  ['needs_review', 'categorized', true],
  ['needs_review', 'excluded', true],
  // from categorized
  ['categorized', 'pending_categorization', true], // rule backfill recategorizes
  ['categorized', 'needs_review', true], // user disputes a categorization
  ['categorized', 'categorized', false],
  ['categorized', 'excluded', true],
  // from excluded
  ['excluded', 'pending_categorization', true], // re-enters the pipeline
  ['excluded', 'needs_review', false], // nothing produces this move
  ['excluded', 'categorized', true], // restores a known-good classification
  ['excluded', 'excluded', false],
];

describe('transaction status transitions (7.4)', () => {
  it('enumerates every ordered pair of statuses', () => {
    expect(TRANSITION_MATRIX).toHaveLength(TRANSACTION_STATUSES.length ** 2);
    expect(new Set(TRANSITION_MATRIX.map(([from, to]) => `${from}->${to}`)).size).toBe(
      TRANSACTION_STATUSES.length ** 2,
    );
  });

  it.each(
    TRANSITION_MATRIX.map(
      ([from, to, allowed]) =>
        [`${from} -> ${to} is ${allowed ? 'allowed' : 'forbidden'}`, from, to, allowed] as const,
    ),
  )('%s', (_title, from, to, allowed) => {
    expect(canTransitionStatus(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => {
        assertStatusTransition(from, to);
      }).not.toThrow();
    } else {
      const error = expectThrows(InvalidStatusTransitionError, () => {
        assertStatusTransition(from, to);
      });
      expect(error.message).toContain(from);
      expect(error.message).toContain(to);
    }
  });

  it('rejects every self-transition, so a no-op write surfaces as a caller bug', () => {
    for (const status of TRANSACTION_STATUSES) {
      expect(canTransitionStatus(status, status)).toBe(false);
    }
  });

  it('exposes the table as data, so the ordering can be asserted directly', () => {
    expect(Object.keys(ALLOWED_STATUS_TRANSITIONS).sort()).toEqual(
      [...TRANSACTION_STATUSES].sort(),
    );
    for (const [from, to, allowed] of TRANSITION_MATRIX) {
      expect(ALLOWED_STATUS_TRANSITIONS[from].has(to)).toBe(allowed);
    }
  });

  it('can always reach excluded from any non-excluded status', () => {
    for (const status of TRANSACTION_STATUSES) {
      if (status === 'excluded') continue;
      expect(canTransitionStatus(status, 'excluded')).toBe(true);
    }
  });
});

describe('enum constants match the 7.4 schema', () => {
  it('lists the account kinds from 7.2, including loan', () => {
    expect([...ACCOUNT_KINDS]).toEqual([
      'checking',
      'savings',
      'credit_card',
      'cash',
      'investment',
      'loan',
    ]);
  });

  it('lists the transaction statuses from 7.4', () => {
    expect([...TRANSACTION_STATUSES]).toEqual([
      'pending_categorization',
      'needs_review',
      'categorized',
      'excluded',
    ]);
  });

  it('lists the categorization sources from 7.4', () => {
    expect([...CATEGORIZATION_SOURCES]).toEqual([
      'manual',
      'rule',
      'ai',
      'recurring_series',
      'import_default',
    ]);
  });
});

/* ============================================================================
   TRANSFER PAIRS - 6.2, Phase 8 task 8.2
   ========================================================================= */

const CHECKING = 'acct-checking';
const SAVINGS = 'acct-savings';
const CARD = 'acct-card';

function leg(
  id: string,
  accountId: string,
  amount: Minor,
  bookedAt: string,
  currency = 'PHP',
): TransferLeg {
  return transferLeg({ transactionId: id, accountId, amount: money(amount, currency), bookedAt });
}

/** The canonical good pair: 2,000.00 out of checking, into savings, same day. */
const OUTGOING = leg('tx-out', CHECKING, -200000n, '2026-03-12');
const INCOMING = leg('tx-in', SAVINGS, 200000n, '2026-03-12');

describe('transfer pairing', () => {
  it('links an exact, same-day, opposite-signed pair', () => {
    const pair = expectOk(evaluateTransferPair(OUTGOING, INCOMING));
    expect(pair.from.transactionId).toBe('tx-out');
    expect(pair.to.transactionId).toBe('tx-in');
    expect(pair.dayGap).toBe(0);
    expect(pair.magnitudeDelta).toBe(0n);
  });

  it('orients from/to by sign, not by argument order', () => {
    const forward = expectOk(evaluateTransferPair(OUTGOING, INCOMING));
    const reversed = expectOk(evaluateTransferPair(INCOMING, OUTGOING));
    expect(reversed.from.transactionId).toBe(forward.from.transactionId);
    expect(reversed.to.transactionId).toBe(forward.to.transactionId);
  });

  it('links the card-payment pair from 6.3', () => {
    // Payment: positive on the card, negative on the funding account.
    const funding = leg('tx-pay-out', CHECKING, -50000n, '2026-03-12');
    const card = leg('tx-pay-in', CARD, 50000n, '2026-03-14');
    const pair = expectOk(evaluateTransferPair(funding, card));
    expect(pair.from.accountId).toBe(CHECKING);
    expect(pair.to.accountId).toBe(CARD);
    expect(pair.dayGap).toBe(2);
  });

  it('rejects a transaction paired with itself', () => {
    const same = { ...INCOMING, transactionId: OUTGOING.transactionId };
    expect(expectErr(evaluateTransferPair(OUTGOING, same)).code).toBe('same_transaction');
  });

  it('rejects two legs in the same account', () => {
    const sameAccount = leg('tx-in', CHECKING, 200000n, '2026-03-12');
    expect(expectErr(evaluateTransferPair(OUTGOING, sameAccount)).code).toBe('same_account');
  });

  it('rejects a cross-currency pair', () => {
    const usd = leg('tx-in', SAVINGS, 200000n, '2026-03-12', 'USD');
    const rejection = expectErr(evaluateTransferPair(OUTGOING, usd));
    expect(rejection.code).toBe('currency_mismatch');
    if (rejection.code === 'currency_mismatch') {
      expect(rejection.left).toBe('PHP');
      expect(rejection.right).toBe('USD');
    }
  });

  it.each([
    ['both negative', -200000n, -1],
    ['both positive', 200000n, 1],
  ] as const)('rejects legs with the same sign (%s)', (_label, amount, sign) => {
    const first = leg('tx-out', CHECKING, amount, '2026-03-12');
    const other = leg('tx-in', SAVINGS, amount, '2026-03-12');
    const rejection = expectErr(evaluateTransferPair(first, other));
    expect(rejection.code).toBe('same_sign');
    if (rejection.code === 'same_sign') expect(rejection.sign).toBe(sign);
  });

  it('rejects a zero-amount leg', () => {
    const zero = leg('tx-in', SAVINGS, 0n, '2026-03-12');
    expect(expectErr(evaluateTransferPair(OUTGOING, zero)).code).toBe('zero_amount');
  });

  describe('magnitude tolerance', () => {
    it('accepts an exact match at the default 0 bps', () => {
      expect(expectOk(evaluateTransferPair(OUTGOING, INCOMING)).magnitudeDelta).toBe(0n);
    });

    it('rejects a one-minor-unit difference at the default 0 bps', () => {
      const off = leg('tx-in', SAVINGS, 199999n, '2026-03-12');
      const rejection = expectErr(evaluateTransferPair(OUTGOING, off));
      expect(rejection.code).toBe('magnitude_mismatch');
      if (rejection.code === 'magnitude_mismatch') {
        expect(rejection.delta).toBe('1');
        expect(rejection.allowed).toBe('0');
      }
    });

    it.each([
      // 100 bps of 200000 is 2000 exactly.
      ['inside', 199000n, true],
      ['exactly at the boundary', 198000n, true],
      ['one unit past the boundary', 197999n, false],
    ])('at 100 bps, a delta %s is accepted=%s', (_label, amount, accepted) => {
      const other = leg('tx-in', SAVINGS, amount, '2026-03-12');
      const result = evaluateTransferPair(OUTGOING, other, { amountToleranceBps: 100 });
      expect(result.ok).toBe(accepted);
    });

    it('measures basis points against the larger leg', () => {
      const bigger = leg('tx-in', SAVINGS, 400000n, '2026-03-12');
      // 100 bps of 400000 = 4000; the delta is 200000, far outside.
      expect(evaluateTransferPair(OUTGOING, bigger, { amountToleranceBps: 100 }).ok).toBe(false);
    });

    it('computes the allowance without floating point', () => {
      // 33 bps of 200000 is 660 exactly; bigint division truncates rather than
      // drifting the way a float multiply would.
      const atLimit = leg('tx-in', SAVINGS, 199340n, '2026-03-12');
      const pastLimit = leg('tx-in', SAVINGS, 199339n, '2026-03-12');
      expect(evaluateTransferPair(OUTGOING, atLimit, { amountToleranceBps: 33 }).ok).toBe(true);
      expect(evaluateTransferPair(OUTGOING, pastLimit, { amountToleranceBps: 33 }).ok).toBe(false);
    });
  });

  describe('date window', () => {
    it.each([
      ['2026-03-12', 0, true],
      ['2026-03-13', 1, true],
      ['2026-03-15', 3, true], // exactly at maxDayGap, inclusive
      ['2026-03-16', 4, false], // one day past
      ['2026-03-09', 3, true], // earlier, still within
      ['2026-03-08', 4, false], // earlier, past
    ])('a leg booked %s is %i days away, accepted=%s', (bookedAt, gap, accepted) => {
      const other = leg('tx-in', SAVINGS, 200000n, bookedAt);
      const result = evaluateTransferPair(OUTGOING, other);
      expect(result.ok).toBe(accepted);
      if (result.ok) {
        expect(result.value.dayGap).toBe(gap);
      } else if (result.error.code === 'date_gap_exceeded') {
        expect(result.error.dayGap).toBe(gap);
      }
    });

    it('measures the gap symmetrically', () => {
      const earlier = leg('tx-in', SAVINGS, 200000n, '2026-03-09');
      const forward = expectOk(evaluateTransferPair(OUTGOING, earlier));
      const reversed = expectOk(evaluateTransferPair(earlier, OUTGOING));
      expect(forward.dayGap).toBe(reversed.dayGap);
    });

    it('does not drift across a month boundary', () => {
      const endOfMonth = leg('tx-out', CHECKING, -200000n, '2026-03-31');
      const nextMonth = leg('tx-in', SAVINGS, 200000n, '2026-04-02');
      expect(expectOk(evaluateTransferPair(endOfMonth, nextMonth)).dayGap).toBe(2);
    });

    it('does not drift across a leap day', () => {
      const before = leg('tx-out', CHECKING, -200000n, '2024-02-28');
      const after = leg('tx-in', SAVINGS, 200000n, '2024-03-01');
      expect(expectOk(evaluateTransferPair(before, after)).dayGap).toBe(2);
    });

    it('honours a widened window', () => {
      const distant = leg('tx-in', SAVINGS, 200000n, '2026-03-22');
      expect(evaluateTransferPair(OUTGOING, distant).ok).toBe(false);
      expect(evaluateTransferPair(OUTGOING, distant, { maxDayGap: 10 }).ok).toBe(true);
    });
  });

  describe('assertTransferPair', () => {
    it('returns the pair when the legs qualify', () => {
      expect(assertTransferPair(OUTGOING, INCOMING).dayGap).toBe(0);
    });

    it.each([
      ['same_transaction', { ...INCOMING, transactionId: 'tx-out' }],
      ['same_account', leg('tx-in', CHECKING, 200000n, '2026-03-12')],
      ['currency_mismatch', leg('tx-in', SAVINGS, 200000n, '2026-03-12', 'USD')],
      ['zero_amount', leg('tx-in', SAVINGS, 0n, '2026-03-12')],
      ['same_sign', leg('tx-in', SAVINGS, -200000n, '2026-03-12')],
      ['magnitude_mismatch', leg('tx-in', SAVINGS, 199999n, '2026-03-12')],
      ['date_gap_exceeded', leg('tx-in', SAVINGS, 200000n, '2026-04-12')],
    ])('throws TransferPairError carrying code %s', (code, other) => {
      const error = expectThrows(TransferPairError, () => assertTransferPair(OUTGOING, other));
      expect(error.details?.[0]?.code).toBe(code.toUpperCase());
      expect(error.status).toBe(422);
    });

    it.each([
      ['negative', -200000n, 'Both legs are negative'],
      ['positive', 200000n, 'Both legs are positive'],
    ] as const)('describes a same-sign rejection when both legs are %s', (_label, amount, text) => {
      const first = leg('tx-out', CHECKING, amount, '2026-03-12');
      const second = leg('tx-in', SAVINGS, amount, '2026-03-12');
      const error = expectThrows(TransferPairError, () => assertTransferPair(first, second));
      expect(error.message).toContain(text);
    });

    it('names both transactions in the detail', () => {
      const other = leg('tx-in', SAVINGS, 199999n, '2026-03-12');
      const error = expectThrows(TransferPairError, () => assertTransferPair(OUTGOING, other));
      expect(error.details?.[0]?.actual).toBe('tx-out + tx-in');
    });
  });

  it('orders legs chronologically for display', () => {
    const later = leg('tx-in', SAVINGS, 200000n, '2026-03-14');
    const pair = expectOk(evaluateTransferPair(OUTGOING, later));
    expect(orderLegsByDate(pair).map((each) => each.transactionId)).toEqual(['tx-out', 'tx-in']);

    const earlierIn = leg('tx-in', SAVINGS, 200000n, '2026-03-10');
    const pair2 = expectOk(evaluateTransferPair(OUTGOING, earlierIn));
    expect(orderLegsByDate(pair2).map((each) => each.transactionId)).toEqual(['tx-in', 'tx-out']);
  });

  it('does not link two unrelated same-amount transactions far apart', () => {
    // The Phase 8 exit criterion, asserted at the domain level.
    const january = leg('tx-a', CHECKING, -150000n, '2026-01-15');
    const march = leg('tx-b', SAVINGS, 150000n, '2026-03-15');
    expect(expectErr(evaluateTransferPair(january, march)).code).toBe('date_gap_exceeded');
  });
});
