import { describe, expect, it } from 'vitest';
import {
  AppError,
  BudgetExceededError,
  ConflictError,
  CurrencyMismatchError,
  ForbiddenError,
  InvalidStatusTransitionError,
  InvariantError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  SplitImbalanceError,
  TransferPairError,
  UnauthorizedError,
  ValidationError,
  isAppError,
} from '@/domain/errors.js';
import type { ErrorDetail } from '@/domain/errors.js';

/**
 * The taxonomy as a table, transcribed from ARCHITECTURE.MD §15.1. Asserting
 * it row by row is what makes a silent status change — the kind that turns a
 * 422 into a 500 at the transport layer — a red test rather than a surprise in
 * Phase 3.
 */
const TAXONOMY = [
  { Ctor: ValidationError, name: 'ValidationError', status: 400, type: 'validation-failed' },
  { Ctor: UnauthorizedError, name: 'UnauthorizedError', status: 401, type: 'unauthorized' },
  { Ctor: ForbiddenError, name: 'ForbiddenError', status: 403, type: 'forbidden' },
  { Ctor: NotFoundError, name: 'NotFoundError', status: 404, type: 'not-found' },
  { Ctor: ConflictError, name: 'ConflictError', status: 409, type: 'conflict' },
  { Ctor: InvariantError, name: 'InvariantError', status: 422, type: 'invariant-violated' },
  { Ctor: SplitImbalanceError, name: 'SplitImbalanceError', status: 422, type: 'split-imbalance' },
  {
    Ctor: CurrencyMismatchError,
    name: 'CurrencyMismatchError',
    status: 422,
    type: 'currency-mismatch',
  },
  {
    Ctor: TransferPairError,
    name: 'TransferPairError',
    status: 422,
    type: 'transfer-pair-invalid',
  },
  {
    Ctor: InvalidStatusTransitionError,
    name: 'InvalidStatusTransitionError',
    status: 422,
    type: 'invalid-status-transition',
  },
  { Ctor: RateLimitError, name: 'RateLimitError', status: 429, type: 'rate-limited' },
  {
    Ctor: BudgetExceededError,
    name: 'BudgetExceededError',
    status: 429,
    type: 'ai-budget-exceeded',
  },
  { Ctor: ProviderError, name: 'ProviderError', status: 502, type: 'provider-failure' },
] as const;

/** The four domain-invariant subclasses, which must also be InvariantErrors. */
const INVARIANT_SUBCLASSES = [
  SplitImbalanceError,
  CurrencyMismatchError,
  TransferPairError,
  InvalidStatusTransitionError,
] as const;

describe('AppError taxonomy', () => {
  describe.each(TAXONOMY)('$name', ({ Ctor, name, status, type }) => {
    it(`maps to HTTP ${String(status)} with type "${type}"`, () => {
      const error = new Ctor('something went wrong');
      expect(error.status).toBe(status);
      expect(error.type).toBe(type);
    });

    it('is operational', () => {
      // Every error in the v1 taxonomy is an expected condition. A future
      // non-operational class (an unexpected internal fault) would land here
      // as a deliberate red test rather than slipping in unnoticed.
      expect(new Ctor('x').isOperational).toBe(true);
    });

    it('reports its own constructor name', () => {
      expect(new Ctor('x').name).toBe(name);
    });

    it('is an AppError and an Error', () => {
      const error = new Ctor('x');
      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(Error);
      expect(isAppError(error)).toBe(true);
    });

    it('carries the message through', () => {
      expect(new Ctor('the message').message).toBe('the message');
    });

    it('has no details unless given any', () => {
      expect(new Ctor('x').details).toBeUndefined();
    });

    it('does not define a cause unless given one', () => {
      // `{ cause: undefined }` would read as "a cause was supplied and it was
      // nothing", which is a different claim from "no cause".
      expect(Object.hasOwn(new Ctor('x'), 'cause')).toBe(false);
    });

    it('produces a usable stack', () => {
      expect(new Ctor('x').stack).toContain(name);
    });
  });

  it('assigns a unique type slug to every class', () => {
    const slugs = TAXONOMY.map((entry) => entry.type);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses slugs, never URIs — the base URI is deployment config (§13.2)', () => {
    for (const { type } of TAXONOMY) {
      expect(type).not.toContain('://');
      expect(type).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('is abstract, so it cannot be constructed directly', () => {
    // `abstract` is erased at runtime, so there is no runtime assertion worth
    // making here — the guarantee is the compiler's, and this assignment is
    // the test. An abstract class is not assignable to a concrete construct
    // signature, so `npm run typecheck` fails if AppError ever becomes
    // concrete: the expected error would vanish and the directive below would
    // report as unused.
    // @ts-expect-error AppError is abstract, so it has no construct signature.
    const ConcreteAppError: new (message: string) => AppError = AppError;
    expect(ConcreteAppError).toBe(AppError);
  });
});

describe('domain invariant subclasses', () => {
  it.each(INVARIANT_SUBCLASSES.map((Ctor) => [Ctor.name, Ctor] as const))(
    '%s is an InvariantError',
    (_name, Ctor) => {
      const error = new Ctor('x');
      expect(error).toBeInstanceOf(InvariantError);
      expect(error).toBeInstanceOf(AppError);
      expect(error.status).toBe(422);
    },
  );

  it('narrows a plain InvariantError away from its subclasses', () => {
    expect(new InvariantError('x')).not.toBeInstanceOf(SplitImbalanceError);
  });
});

describe('AppError options', () => {
  it('preserves the cause', () => {
    const cause = new Error('underlying');
    const error = new ProviderError('llm call failed', { cause });
    expect(error.cause).toBe(cause);
  });

  it('accepts a non-Error cause', () => {
    const error = new ProviderError('llm call failed', { cause: { status: 503 } });
    expect(error.cause).toEqual({ status: 503 });
  });

  it('round-trips field-level details', () => {
    const details: ErrorDetail[] = [
      { field: 'splits', code: 'SUM_MISMATCH', expected: '-50000', actual: '-45000' },
    ];
    const error = new SplitImbalanceError('Splits do not balance', { details });
    expect(error.details).toEqual(details);
  });

  it('allows a detail without expected/actual', () => {
    const error = new ValidationError('bad input', {
      details: [{ field: 'currency', code: 'INVALID_ISO_4217' }],
    });
    expect(error.details).toEqual([{ field: 'currency', code: 'INVALID_ISO_4217' }]);
  });

  it('carries monetary detail as strings, so the payload survives JSON.stringify', () => {
    // §6.4: bigint throws in JSON.stringify. This is why ErrorDetail.expected
    // and .actual are strings rather than numbers or bigints.
    const error = new SplitImbalanceError('imbalance', {
      details: [{ field: 'splits', code: 'SUM_MISMATCH', expected: '-50000', actual: '-45000' }],
    });
    expect(() => JSON.stringify(error.details)).not.toThrow();
  });

  it('accepts both a cause and details at once', () => {
    const cause = new Error('root');
    const error = new ConflictError('duplicate', {
      cause,
      details: [{ field: 'dedupHash', code: 'DUPLICATE' }],
    });
    expect(error.cause).toBe(cause);
    expect(error.details).toHaveLength(1);
  });
});

describe('isAppError', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain object', {}],
    ['a string', 'ValidationError'],
    ['a number', 422],
    ['a bare Error', new Error('bare')],
    ['a TypeError', new TypeError('nope')],
  ])('returns false for %s', (_label, value) => {
    expect(isAppError(value)).toBe(false);
  });

  it('narrows in a catch block', () => {
    try {
      throw new NotFoundError('account not found');
    } catch (caught: unknown) {
      expect(isAppError(caught)).toBe(true);
      if (isAppError(caught)) {
        expect(caught.status).toBe(404);
      }
    }
  });
});
