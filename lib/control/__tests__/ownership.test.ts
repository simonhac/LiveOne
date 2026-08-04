/**
 * The two expressions of the owner-only control rule (`lib/control/ownership.ts`).
 *
 * 🛑 The load-bearing case is `ownsSubject(null, null) === false`. Ownership is a string compare,
 * so on an OWNERLESS device an anonymous caller compares `null === null` and would otherwise come
 * back "owner" while owning nothing — the quirk `/api/data` used to mask by hand. An ownerless
 * device must be commandable by NOBODY.
 */
import { describe, it, expect } from "@jest/globals";
import {
  datumCanControl,
  datumCanControlPoint,
  ownsSubject,
} from "../ownership";

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

/**
 * 🛑 The gate the EV cog actually renders on. `datumCanControl` answers about the payload's SUBJECT;
 * this one answers about the DEVICE the control would command, which for a tile inside a
 * multi-device area is a different thing. Getting that wrong is what put a cog in front of an area
 * owner that 403ed when pressed.
 */
describe("datumCanControlPoint", () => {
  const PATHS = ["ev.charge/active", "ev.charge.limit/soc"] as const;
  const area = (over: Record<string, unknown> = {}) => ({
    area: { id: 1000002 },
    canControl: true,
    canControlDevices: [11],
    latest: {
      "ev.charge/active": { sourceSystemId: 10 },
      "bidi.grid/power": { sourceSystemId: 11 },
    },
    ...over,
  });

  it("🛑 the AREA owner who does not own the car gets NO control", () => {
    // `canControl` is true (they own the area) and it must NOT be what decides.
    expect(datumCanControlPoint(area(), PATHS)).toBe(false);
  });

  it("the car's owner does, even when they do not own the area", () => {
    expect(
      datumCanControlPoint(
        area({ canControl: false, canControlDevices: [10] }),
        PATHS,
      ),
    ).toBe(true);
  });

  it("falls through to the next path when the first is absent", () => {
    expect(
      datumCanControlPoint(
        {
          area: {},
          canControlDevices: [10],
          latest: { "ev.charge.limit/soc": { sourceSystemId: 10 } },
        },
        PATHS,
      ),
    ).toBe(true);
  });

  it("no target point in the payload → nothing to command → false", () => {
    expect(
      datumCanControlPoint(
        { area: {}, canControl: true, canControlDevices: [10], latest: {} },
        PATHS,
      ),
    ).toBe(false);
  });

  it("an SSR-seeded payload (neither field) is false", () => {
    expect(datumCanControlPoint({ latest: {} }, PATHS)).toBe(false);
    expect(datumCanControlPoint(null, PATHS)).toBe(false);
    expect(datumCanControlPoint(undefined, PATHS)).toBe(false);
  });

  describe("a stale KV entry with no sourceSystemId", () => {
    it("on a DEVICE subject, falls back to the subject flag (subject IS the target)", () => {
      const datum = {
        device: { id: 10 },
        canControl: true,
        canControlDevices: [10],
        latest: { "ev.charge/active": {} },
      };
      expect(datumCanControlPoint(datum, PATHS)).toBe(true);
      expect(
        datumCanControlPoint({ ...datum, canControl: false }, PATHS),
      ).toBe(false);
    });

    it("🛑 on an AREA subject, stays FALSE — that is the ambiguity this exists to refuse", () => {
      expect(
        datumCanControlPoint(
          {
            area: { id: 1000002 },
            canControl: true,
            canControlDevices: [10],
            latest: { "ev.charge/active": {} },
          },
          PATHS,
        ),
      ).toBe(false);
    });
  });
});
