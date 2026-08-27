import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, map, mapErr, ok, unwrap, unwrapOr } from '@/lib/result.js';
import type { Result } from '@/lib/result.js';

describe('Result', () => {
  it('discriminates on `ok` without a type guard', () => {
    const success: Result<number, string> = ok(42);
    const failure: Result<number, string> = err('boom');

    // The point of the discriminated union: narrowing is structural.
    expect(success.ok ? success.value : null).toBe(42);
    expect(failure.ok ? null : failure.error).toBe('boom');
  });

  it('carries the success value on ok()', () => {
    expect(ok('value')).toEqual({ ok: true, value: 'value' });
  });

  it('carries the error value on err()', () => {
    expect(err(new Error('x')).ok).toBe(false);
  });

  it('distinguishes ok from err with the guards', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
    expect(isOk(err(1))).toBe(false);
    expect(isErr(err(1))).toBe(true);
  });

  it('treats a falsy success value as success', () => {
    const zero: Result<number, string> = ok(0);
    const empty: Result<string, string> = ok('');
    expect(isOk(zero)).toBe(true);
    expect(isOk(empty)).toBe(true);
    expect(unwrapOr(zero, 99)).toBe(0);
  });

  describe('map', () => {
    it('transforms a success', () => {
      expect(map(ok(2), (n) => n * 3)).toEqual({ ok: true, value: 6 });
    });

    it('leaves a failure untouched and does not call the function', () => {
      let called = false;
      const result = map(err<string>('bad'), (n: number) => {
        called = true;
        return n;
      });
      expect(result).toEqual({ ok: false, error: 'bad' });
      expect(called).toBe(false);
    });
  });

  describe('mapErr', () => {
    it('transforms a failure', () => {
      expect(mapErr(err('bad'), (e) => e.toUpperCase())).toEqual({ ok: false, error: 'BAD' });
    });

    it('leaves a success untouched', () => {
      expect(mapErr(ok(1), () => 'never')).toEqual({ ok: true, value: 1 });
    });
  });

  describe('unwrapOr', () => {
    it('returns the value on success', () => {
      expect(unwrapOr(ok('a'), 'fallback')).toBe('a');
    });

    it('returns the fallback on failure', () => {
      expect(unwrapOr(err<string>('bad'), 'fallback')).toBe('fallback');
    });
  });

  describe('unwrap', () => {
    it('returns the value on success', () => {
      expect(unwrap(ok(7))).toBe(7);
    });

    it('throws, naming the error, on failure', () => {
      expect(() => unwrap(err('split imbalance'))).toThrow(/split imbalance/);
    });
  });
});
