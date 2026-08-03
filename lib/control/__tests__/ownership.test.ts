/**
 * The two expressions of the owner-only control rule (`lib/control/ownership.ts`).
 *
 * 🛑 The load-bearing case is `ownsSubject(null, null) === false`. Ownership is a string compare,
 * so on an OWNERLESS device an anonymous caller compares `null === null` and would otherwise come
 * back "owner" while owning nothing — the quirk `/api/data` used to mask by hand. An ownerless
 * device must be commandable by NOBODY.
 */
import { describe, it, expect } from "@jest/globals";
import { datumCanControl, ownsSubject } from "../ownership";

describe("ownsSubject", () => {
  it("the owner owns it", () => {
    expect(ownsSubject("user_owner", "user_owner")).toBe(true);
  });

  it("a different identity does not — an ADMIN is just another user here", () => {
    expect(ownsSubject("user_admin", "user_owner")).toBe(false);
  });

  it("🛑 two nulls are NOT a match (anonymous caller, ownerless device)", () => {
    expect(ownsSubject(null, null)).toBe(false);
    expect(ownsSubject(undefined, undefined)).toBe(false);
    expect(ownsSubject(undefined, null)).toBe(false);
  });

  it("an ownerless device is owned by nobody, however identified", () => {
    expect(ownsSubject("user_owner", null)).toBe(false);
    expect(ownsSubject("claude-dev", null)).toBe(false);
  });

  it("an anonymous caller never owns an OWNED device", () => {
    expect(ownsSubject(null, "user_owner")).toBe(false);
  });
});

describe("datumCanControl", () => {
  it("true only for an explicit true", () => {
    expect(datumCanControl({ canControl: true })).toBe(true);
    expect(datumCanControl({ canControl: false })).toBe(false);
  });

  it("an SSR-seeded payload (no viewer, so no field) is false, not undefined", () => {
    expect(datumCanControl({})).toBe(false);
    expect(datumCanControl(undefined)).toBe(false);
    expect(datumCanControl(null)).toBe(false);
  });
});
