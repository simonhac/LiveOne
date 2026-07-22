/**
 * Crockford base32 codec for TypeIDs — 16 bytes (a UUID) <-> 26 lowercase chars.
 *
 * This is the exact encoding the TypeID spec (github.com/jetify-com/typeid) borrows from ULID: the
 * lowercase Crockford alphabet (no `i l o u`), an unrolled 128-bit bit-packing, and a strict decode
 * (rejects uppercase, ambiguous chars, wrong length, and the leading-bits overflow). Ported to match
 * the spec's `valid.yml` / `invalid.yml` vectors byte-for-byte — see `__tests__/base32.test.ts`.
 *
 * Client-safe: no `node:crypto`, no `Buffer`. Pure bit math over `Uint8Array`.
 */

export const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type Base32ErrorReason = "bad-length" | "bad-char" | "overflow";

/** Thrown by {@link decodeBase32}/{@link encodeBase32}; `reason` lets callers map to a domain error. */
export class Base32Error extends Error {
  constructor(
    public readonly reason: Base32ErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "Base32Error";
  }
}

/** char code -> 5-bit value; 0xff marks a code that is not in the alphabet. */
const DEC: Uint8Array = (() => {
  const t = new Uint8Array(256).fill(0xff);
  for (let i = 0; i < BASE32_ALPHABET.length; i++)
    t[BASE32_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Encode exactly 16 bytes to a 26-char lowercase base32 suffix. */
export function encodeBase32(src: Uint8Array): string {
  if (src.length !== 16)
    throw new Base32Error("bad-length", `expected 16 bytes, got ${src.length}`);
  const a = BASE32_ALPHABET;
  return (
    a[(src[0] & 0xe0) >> 5] +
    a[src[0] & 0x1f] +
    a[(src[1] & 0xf8) >> 3] +
    a[((src[1] & 0x07) << 2) | ((src[2] & 0xc0) >> 6)] +
    a[(src[2] & 0x3e) >> 1] +
    a[((src[2] & 0x01) << 4) | ((src[3] & 0xf0) >> 4)] +
    a[((src[3] & 0x0f) << 1) | ((src[4] & 0x80) >> 7)] +
    a[(src[4] & 0x7c) >> 2] +
    a[((src[4] & 0x03) << 3) | ((src[5] & 0xe0) >> 5)] +
    a[src[5] & 0x1f] +
    a[(src[6] & 0xf8) >> 3] +
    a[((src[6] & 0x07) << 2) | ((src[7] & 0xc0) >> 6)] +
    a[(src[7] & 0x3e) >> 1] +
    a[((src[7] & 0x01) << 4) | ((src[8] & 0xf0) >> 4)] +
    a[((src[8] & 0x0f) << 1) | ((src[9] & 0x80) >> 7)] +
    a[(src[9] & 0x7c) >> 2] +
    a[((src[9] & 0x03) << 3) | ((src[10] & 0xe0) >> 5)] +
    a[src[10] & 0x1f] +
    a[(src[11] & 0xf8) >> 3] +
    a[((src[11] & 0x07) << 2) | ((src[12] & 0xc0) >> 6)] +
    a[(src[12] & 0x3e) >> 1] +
    a[((src[12] & 0x01) << 4) | ((src[13] & 0xf0) >> 4)] +
    a[((src[13] & 0x0f) << 1) | ((src[14] & 0x80) >> 7)] +
    a[(src[14] & 0x7c) >> 2] +
    a[((src[14] & 0x03) << 3) | ((src[15] & 0xe0) >> 5)] +
    a[src[15] & 0x1f]
  );
}

/** Decode a 26-char lowercase base32 suffix back to 16 bytes. Strict — see file header. */
export function decodeBase32(s: string): Uint8Array {
  if (s.length !== 26)
    throw new Base32Error("bad-length", `expected 26 chars, got ${s.length}`);
  for (let i = 0; i < 26; i++) {
    if (DEC[s.charCodeAt(i)] === 0xff)
      throw new Base32Error(
        "bad-char",
        `invalid base32 char ${JSON.stringify(s[i])} at index ${i}`,
      );
  }
  // The first char carries only the top 3 bits of the 128, so it must be 0-7; anything higher would
  // overflow 16 bytes on the way back in.
  if (DEC[s.charCodeAt(0)] > 7)
    throw new Base32Error(
      "overflow",
      "first character must be in 0-7 (128-bit overflow)",
    );

  const c = (i: number) => DEC[s.charCodeAt(i)];
  const dst = new Uint8Array(16); // assignment truncates to 8 bits — the standard ULID/TypeID trick
  dst[0] = (c(0) << 5) | c(1);
  dst[1] = (c(2) << 3) | (c(3) >> 2);
  dst[2] = (c(3) << 6) | (c(4) << 1) | (c(5) >> 4);
  dst[3] = (c(5) << 4) | (c(6) >> 1);
  dst[4] = (c(6) << 7) | (c(7) << 2) | (c(8) >> 3);
  dst[5] = (c(8) << 5) | c(9);
  dst[6] = (c(10) << 3) | (c(11) >> 2);
  dst[7] = (c(11) << 6) | (c(12) << 1) | (c(13) >> 4);
  dst[8] = (c(13) << 4) | (c(14) >> 1);
  dst[9] = (c(14) << 7) | (c(15) << 2) | (c(16) >> 3);
  dst[10] = (c(16) << 5) | c(17);
  dst[11] = (c(18) << 3) | (c(19) >> 2);
  dst[12] = (c(19) << 6) | (c(20) << 1) | (c(21) >> 4);
  dst[13] = (c(21) << 4) | (c(22) >> 1);
  dst[14] = (c(22) << 7) | (c(23) << 2) | (c(24) >> 3);
  dst[15] = (c(24) << 5) | c(25);
  return dst;
}
