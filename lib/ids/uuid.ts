/**
 * UUID <-> bytes helpers + a UUIDv7 mint, for the TypeID codec.
 *
 * Client-safe: uses the `uuidv7` package (which uses `crypto.getRandomValues`), NOT `node:crypto`.
 * This is the deliberate mirror of `lib/identifiers/point-uid.ts` — that module stays server-only
 * because it mints deterministic uuidv5 IDENTITIES via SHA-1; this one only does wire encoding and
 * v7 generation, so it is safe to import from client React. Keep the two apart.
 */
import { uuidv7 } from "uuidv7";

/** Mint a fresh UUIDv7 in canonical lowercase form. */
export function newUuidV7(): string {
  return uuidv7();
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True iff `s` is a canonical 36-char hyphenated UUID (either case). */
export function isCanonicalUuid(s: string): boolean {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Canonical UUID string -> 16 bytes. Throws on a non-canonical input (a programmer error). */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!isCanonicalUuid(uuid))
    throw new TypeError(`not a canonical UUID: ${JSON.stringify(uuid)}`);
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** 16 bytes -> canonical lowercase UUID string. */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16)
    throw new TypeError(`expected 16 bytes, got ${bytes.length}`);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
