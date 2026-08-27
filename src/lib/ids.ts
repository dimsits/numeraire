/**
 * Identifier generation.
 *
 * CLAUDE.md: IDs come from this module, never `crypto.randomUUID()` inline.
 *
 * UUIDv7 (RFC 9562) rather than v4: the leading 48 bits are a Unix millisecond
 * timestamp, so identifiers sort chronologically. That gives locality on
 * B-tree index inserts and makes keyset pagination over `(created_at, id)`
 * behave sensibly — see ADR-007.
 *
 * Note a documented discrepancy: ARCHITECTURE.md §17.1 describes `requestId`
 * as a ULID. ULIDs are not introduced in v1; UUIDv7 provides the same
 * time-ordering property, and DEV_PIPELINE.md §1.2 names UUIDv7 as the single
 * source of identifiers. Both entity and request IDs are UUIDv7 here.
 */
import { v7 as uuidv7 } from 'uuid';

/** Canonical 8-4-4-4-12 hexadecimal UUID form. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identifier for a persisted entity. */
export function newId(): string {
  return uuidv7();
}

/**
 * Identifier for a single request or job execution. Carried on every log line
 * and written to matching audit rows (ARCHITECTURE.md §17.1).
 */
export function newRequestId(): string {
  return uuidv7();
}

/** True when `value` is a well-formed UUID of any version. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** True when `value` is a well-formed UUID whose version nibble is 7. */
export function isUuidV7(value: string): boolean {
  return isUuid(value) && value.charAt(14) === '7';
}

/**
 * The embedded creation timestamp, in epoch milliseconds.
 * Returns `undefined` for anything that is not a UUIDv7.
 */
export function timestampOf(id: string): number | undefined {
  if (!isUuidV7(id)) return undefined;
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
