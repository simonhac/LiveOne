import { describe, it, expect } from "@jest/globals";
import {
  uuidv5,
  derivePointUid,
  POINT_UID_NAMESPACE,
} from "@/lib/identifiers/point-uid";

describe("uuidv5", () => {
  it("matches the RFC-4122 test vector (DNS namespace, www.example.com)", () => {
    expect(
      uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("produces a version-5, RFC-4122-variant UUID", () => {
    const u = uuidv5("anything");
    expect(u).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("derivePointUid", () => {
  it("is deterministic for the same vendor identity", () => {
    const a = derivePointUid("selectronic", "site-123", "selectronic/solar_w");
    const b = derivePointUid("selectronic", "site-123", "selectronic/solar_w");
    expect(a).toBe(b);
  });

  it("differs when any component differs", () => {
    const base = derivePointUid("selectronic", "site-123", "solar_w");
    expect(derivePointUid("enphase", "site-123", "solar_w")).not.toBe(base);
    expect(derivePointUid("selectronic", "site-999", "solar_w")).not.toBe(base);
    expect(derivePointUid("selectronic", "site-123", "battery_w")).not.toBe(
      base,
    );
  });

  it("is equivalent to uuidv5 over the joined tuple under the point namespace", () => {
    expect(derivePointUid("v", "s", "p")).toBe(
      uuidv5("v:s:p", POINT_UID_NAMESPACE),
    );
  });
});
