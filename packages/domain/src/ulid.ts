/**
 * Opaque ULID identifier. Construct via `id as ULID` at trust boundaries
 * (DB row hydration, validated request payloads, fresh-id generation).
 * Generation lives in `@pc/db` (`newId()`).
 */
export type ULID = string & { readonly _brand: 'ULID' };

/** 26-char Crockford base32 (no I, L, O, U). Case-insensitive per the ULID
 *  spec — `newId()` emits uppercase. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

/** Runtime check for the ULID brand — use at trust boundaries (DB hydration,
 *  request payloads) instead of a bare `as ULID` cast. */
export function isUlid(value: unknown): value is ULID {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}
