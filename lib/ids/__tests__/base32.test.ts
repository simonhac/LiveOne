import { describe, it, expect } from "@jest/globals";
import { Base32Error, decodeBase32, encodeBase32 } from "@/lib/ids/base32";
import { bytesToUuid, uuidToBytes } from "@/lib/ids/uuid";

/**
 * Known vectors lifted from the TypeID spec `valid.yml` (github.com/jetify-com/typeid) — the suffix
 * is the base32 of the uuid's 16 bytes. Passing these byte-for-byte is what guarantees our codec is
 * interoperable with every other TypeID implementation.
 */
const VECTORS: Array<{ name: string; uuid: string; suffix: string }> = [
  {
    name: "nil",
    uuid: "00000000-0000-0000-0000-000000000000",
    suffix: "00000000000000000000000000",
  },
  {
    name: "max",
    uuid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    suffix: "7zzzzzzzzzzzzzzzzzzzzzzzzz",
  },
  {
    name: "full-alphabet",
    uuid: "0110c853-1d09-52d8-d73e-1194e95b5f19",
    suffix: "0123456789abcdefghjkmnpqrs",
  },
  {
    name: "uuidv7",
    uuid: "01890a5d-ac96-774b-bcce-b302099a8057",
    suffix: "01h455vb4pex5vsknk084sn02q",
  },
];

describe("encodeBase32 / decodeBase32", () => {
  for (const v of VECTORS) {
    it(`encodes the ${v.name} vector`, () => {
      expect(encodeBase32(uuidToBytes(v.uuid))).toBe(v.suffix);
    });
    it(`decodes the ${v.name} vector`, () => {
      expect(bytesToUuid(decodeBase32(v.suffix))).toBe(v.uuid);
    });
  }

  it("round-trips arbitrary 16-byte patterns", () => {
    // encode's first char is always the top 3 bits of byte 0 (value 0-7), so any 16 bytes — even
    // 0xff-heavy ones — encode to a decodable suffix and survive the round trip.
    for (let seed = 0; seed < 64; seed++) {
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) bytes[i] = (seed * 31 + i * 7) & 0xff;
      const roundTripped = decodeBase32(encodeBase32(bytes));
      expect(Array.from(roundTripped)).toEqual(Array.from(bytes));
    }
  });

  it("encode rejects the wrong byte length", () => {
    expect(() => encodeBase32(new Uint8Array(15))).toThrow(Base32Error);
    try {
      encodeBase32(new Uint8Array(17));
    } catch (e) {
      expect((e as Base32Error).reason).toBe("bad-length");
    }
  });

  it("decode rejects the wrong length", () => {
    expect(() => decodeBase32("0".repeat(25))).toThrow(Base32Error);
    expect(() => decodeBase32("0".repeat(27))).toThrow(Base32Error);
    try {
      decodeBase32("0".repeat(25));
    } catch (e) {
      expect((e as Base32Error).reason).toBe("bad-length");
    }
  });

  it("decode rejects characters outside the Crockford alphabet", () => {
    // 'i', 'l', 'o', 'u' are excluded; uppercase is rejected (strict).
    for (const bad of ["i", "l", "o", "u", "A", "Z"]) {
      const s = bad + "0".repeat(25);
      try {
        decodeBase32(s);
        throw new Error(`expected rejection of ${JSON.stringify(s)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(Base32Error);
        expect((e as Base32Error).reason).toBe("bad-char");
      }
    }
  });

  it("decode rejects a first character that overflows 128 bits (must be 0-7)", () => {
    for (const bad of ["8", "9", "a", "z"]) {
      const s = bad + "0".repeat(25);
      try {
        decodeBase32(s);
        throw new Error(`expected overflow rejection of ${JSON.stringify(s)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(Base32Error);
        // 'a'/'z' are valid chars but invalid as the leading char -> overflow, not bad-char.
        expect((e as Base32Error).reason).toBe("overflow");
      }
    }
  });
});
