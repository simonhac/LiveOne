import { describe, it, expect } from "@jest/globals";
import {
  Area,
  Binding,
  Dashboard,
  Derivation,
  Device,
  ID_PREFIX,
  Point,
  decodeTypeId,
  encodeTypeId,
  isCanonicalUuid,
} from "@/lib/ids";

describe("decodeTypeId — spec vectors", () => {
  it("decodes the empty-prefix nil id", () => {
    const r = decodeTypeId("", "00000000000000000000000000");
    expect(r).toEqual({
      ok: true,
      uuid: "00000000-0000-0000-0000-000000000000",
    });
  });

  it("decodes a prefixed uuidv7 id", () => {
    const r = decodeTypeId("prefix", "prefix_01h455vb4pex5vsknk084sn02q");
    expect(r).toEqual({
      ok: true,
      uuid: "01890a5d-ac96-774b-bcce-b302099a8057",
    });
  });

  it("decodes the full-alphabet id", () => {
    const r = decodeTypeId("prefix", "prefix_0123456789abcdefghjkmnpqrs");
    expect(r).toEqual({
      ok: true,
      uuid: "0110c853-1d09-52d8-d73e-1194e95b5f19",
    });
  });
});

describe("encodeTypeId", () => {
  it("round-trips a uuid through a prefix", () => {
    const uuid = "01890a5d-ac96-774b-bcce-b302099a8057";
    const id = encodeTypeId("dv", uuid);
    expect(id).toBe("dv_01h455vb4pex5vsknk084sn02q");
    expect(decodeTypeId("dv", id)).toEqual({ ok: true, uuid });
  });

  it("throws on a non-canonical uuid (programmer error, not untrusted input)", () => {
    expect(() => encodeTypeId("dv", "not-a-uuid")).toThrow();
  });
});

describe("ID_PREFIX matches the codecs", () => {
  it("uses the confirmed 2-letter prefixes", () => {
    expect([
      Device.prefix,
      Point.prefix,
      Area.prefix,
      Dashboard.prefix,
      Derivation.prefix,
      Binding.prefix,
    ]).toEqual(["dv", "pt", "ar", "db", "dx", "bn"]);
    expect(ID_PREFIX).toEqual({
      device: "dv",
      point: "pt",
      area: "ar",
      dashboard: "db",
      derivation: "dx",
      binding: "bn",
    });
  });
});

describe("EntityCodec", () => {
  it("generate() mints a well-formed, unique id that parses back", () => {
    const a = Device.generate();
    const b = Device.generate();
    expect(a).not.toBe(b);
    expect(a.startsWith("dv_")).toBe(true);
    expect(a).toHaveLength(3 + 26);
    const parsed = Device.parse(a);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.id).toBe(a);
    // generate() is uuidv7-backed -> toUuid yields a canonical uuid.
    expect(isCanonicalUuid(Device.toUuid(a))).toBe(true);
  });

  it("encode -> toUuid round-trips (lowercased)", () => {
    const uuid = "01890A5D-AC96-774B-BCCE-B302099A8057"; // upper-case input
    const id = Point.encode(uuid);
    expect(id).toBe("pt_01h455vb4pex5vsknk084sn02q");
    expect(Point.toUuid(id)).toBe(uuid.toLowerCase());
  });

  it("parse rejects the wrong entity prefix", () => {
    const dv = Device.generate();
    const r = Point.parse(dv);
    expect(r).toMatchObject({ ok: false, code: "wrong-prefix" });
  });

  it("toUuid throws on a foreign-entity id", () => {
    const dv = Device.generate();
    expect(() =>
      Point.toUuid(dv as unknown as ReturnType<typeof Point.generate>),
    ).toThrow();
  });

  it("is() is a correct type guard", () => {
    expect(Device.is(Device.generate())).toBe(true);
    expect(Device.is(Point.generate())).toBe(false);
    expect(Device.is("garbage")).toBe(false);
  });

  describe("parse — malformed inputs map to typed codes", () => {
    const suffix = "01h455vb4pex5vsknk084sn02q"; // valid 26-char base32
    const cases: Array<{ name: string; input: string; code: string }> = [
      { name: "empty string", input: "", code: "malformed-format" },
      {
        name: "no underscore separator",
        input: `dv${suffix}`,
        code: "malformed-format",
      },
      {
        name: "leading underscore / empty prefix",
        input: `_${suffix}`,
        code: "empty-prefix",
      },
      {
        name: "overflow suffix",
        input: `dv_8${"0".repeat(25)}`,
        code: "malformed-suffix",
      },
      {
        name: "bad-char suffix",
        input: `dv_i${"0".repeat(25)}`,
        code: "malformed-suffix",
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        const r = Device.parse(c.input);
        expect(r).toMatchObject({ ok: false, code: c.code });
      });
    }
  });
});
