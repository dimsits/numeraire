import { describe, expect, it } from 'vitest';
import { isUuid, isUuidV7, newId, newRequestId, timestampOf } from '@/lib/ids.js';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('newId', () => {
  it('produces a canonical 36-character UUID', () => {
    const id = newId();
    expect(id).toHaveLength(36);
    expect(id).toMatch(UUID_SHAPE);
  });

  it('sets the version nibble to 7', () => {
    // Character 14 is the version field in the 8-4-4-4-12 layout.
    expect(newId().charAt(14)).toBe('7');
  });

  it('sets the RFC 9562 variant bits to 10xx', () => {
    const variant = Number.parseInt(newId().charAt(19), 16);
    expect(variant & 0b1100).toBe(0b1000);
  });

  it('does not repeat across a burst', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => newId()));
    expect(ids.size).toBe(5_000);
  });

  it('sorts chronologically as a string — the reason for v7 over v4', () => {
    const ids = Array.from({ length: 500 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('newRequestId', () => {
  it('is also a UUIDv7', () => {
    expect(isUuidV7(newRequestId())).toBe(true);
  });

  it('differs from an entity id drawn at the same moment', () => {
    expect(newRequestId()).not.toBe(newId());
  });
});

describe('isUuid', () => {
  it('accepts a generated id', () => {
    expect(isUuid(newId())).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isUuid(newId().toUpperCase())).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not hex', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'],
    ['no dashes', '0192a1b2c3d47e8f9a0b1c2d3e4f5a6b'],
    ['too short', '0192a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a'],
    ['trailing text', '0192a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b-extra'],
  ])('rejects %s', (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });
});

describe('isUuidV7', () => {
  it('rejects a well-formed UUID of a different version', () => {
    const v4 = '0192a1b2-c3d4-4e8f-9a0b-1c2d3e4f5a6b';
    expect(isUuid(v4)).toBe(true);
    expect(isUuidV7(v4)).toBe(false);
  });
});

describe('timestampOf', () => {
  it('recovers a creation time within a second of now', () => {
    const before = Date.now();
    const extracted = timestampOf(newId());
    expect(extracted).toBeDefined();
    expect(extracted!).toBeGreaterThanOrEqual(before - 1_000);
    expect(extracted!).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('orders two ids taken milliseconds apart', async () => {
    const first = timestampOf(newId())!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = timestampOf(newId())!;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('returns undefined for anything that is not a UUIDv7', () => {
    expect(timestampOf('not-an-id')).toBeUndefined();
    expect(timestampOf('0192a1b2-c3d4-4e8f-9a0b-1c2d3e4f5a6b')).toBeUndefined();
  });
});
