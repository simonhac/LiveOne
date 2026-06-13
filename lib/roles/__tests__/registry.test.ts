import { describe, it, expect } from "@jest/globals";
import {
  ROLES,
  ROLE_IDS,
  COMPOSITE_VALIDATED_ROLE_IDS,
  stemMatchesRole,
  isCompleteRoleSet,
  type RoleId,
} from "../registry";

describe("role registry", () => {
  it("ROLE_IDS is the energy-flow role set, in panel order", () => {
    expect(ROLE_IDS).toEqual(["solar", "battery", "load", "grid", "ev"]);
  });

  it("any ROLES key outside ROLE_IDS is a trackable device role (e.g. generator)", () => {
    // Device roles (run-tracking) live in ROLES for FK/metadata but are deliberately NOT in
    // ROLE_IDS, so they don't appear in the composite editor's energy-flow panels.
    const extras = Object.keys(ROLES).filter(
      (k) => !(ROLE_IDS as readonly string[]).includes(k),
    );
    expect(extras).toContain("generator");
    for (const id of extras) {
      expect(ROLES[id as keyof typeof ROLES].device?.trackable).toBe(true);
    }
  });

  it("every role carries HA export metadata", () => {
    for (const id of Object.keys(ROLES) as Array<keyof typeof ROLES>) {
      const ha = ROLES[id].ha;
      expect(ha.deviceClass).toBeTruthy();
      expect(ha.stateClass).toBeTruthy();
      expect(ha.unit).toBeTruthy();
    }
  });

  it("only solar/battery/load/grid are composite-path-validated (ev is not)", () => {
    expect([...COMPOSITE_VALIDATED_ROLE_IDS]).toEqual([
      "solar",
      "battery",
      "load",
      "grid",
    ]);
  });

  describe("stemMatchesRole — exact anchor or dotted descendant", () => {
    const cases: Array<[string, RoleId, boolean]> = [
      ["source.solar", "solar", true],
      ["source.solar.local", "solar", true],
      ["source.solarx", "solar", false],
      ["bidi.battery", "battery", true],
      ["bidi.battery.charge", "battery", true],
      ["bidi.grid", "grid", true],
      ["load", "load", true],
      ["load.hvac", "load", true],
      ["loadx", "load", false],
      ["ev", "ev", true],
      ["ev.battery", "ev", true],
      ["source.solar", "battery", false],
    ];
    it.each(cases)("%s as %s -> %s", (stem, role, expected) => {
      expect(stemMatchesRole(stem, role)).toBe(expected);
    });
  });

  describe("isCompleteRoleSet", () => {
    it("needs a source and a load", () => {
      expect(isCompleteRoleSet(["source.solar", "load"])).toBe(true);
      expect(isCompleteRoleSet(["source.solar"])).toBe(false);
      expect(isCompleteRoleSet(["load", "load.hws"])).toBe(false);
    });
    it("treats battery/grid as both (exact match)", () => {
      expect(isCompleteRoleSet(["bidi.battery"])).toBe(true);
      expect(isCompleteRoleSet(["bidi.grid"])).toBe(true);
    });
    it("is empty-safe and ignores unknown stems", () => {
      expect(isCompleteRoleSet([])).toBe(false);
      expect(isCompleteRoleSet(["unknown.thing"])).toBe(false);
    });
  });
});
