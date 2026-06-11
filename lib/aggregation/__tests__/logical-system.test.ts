import { describe, it, expect } from "@jest/globals";
import { isCompleteRoleSet } from "../logical-system";

describe("isCompleteRoleSet", () => {
  it("is complete when there is a source and a load role", () => {
    expect(isCompleteRoleSet(["source.solar", "load"])).toBe(true);
    expect(isCompleteRoleSet(["source.solar.local", "load.hws"])).toBe(true);
  });

  it("treats battery/grid as both a source and a load (they split)", () => {
    expect(isCompleteRoleSet(["bidi.battery"])).toBe(true);
    expect(isCompleteRoleSet(["bidi.grid"])).toBe(true);
  });

  it("is incomplete with only generation (e.g. a solar-only override feed)", () => {
    expect(isCompleteRoleSet(["source.solar"])).toBe(false);
    expect(
      isCompleteRoleSet(["source.solar.local", "source.solar.remote"]),
    ).toBe(false);
  });

  it("is incomplete with only loads", () => {
    expect(isCompleteRoleSet(["load", "load.hws"])).toBe(false);
  });

  it("is incomplete with no role-bearing stems", () => {
    expect(isCompleteRoleSet([])).toBe(false);
    expect(isCompleteRoleSet(["unknown.thing"])).toBe(false);
  });
});
