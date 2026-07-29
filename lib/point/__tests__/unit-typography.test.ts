import { describe, it, expect } from "@jest/globals";
import { classifyUnit, isTightUnit } from "../unit-typography";

/** Compact spelling of a classified unit, for readable expectations. */
function render(unit: string): string {
  const { head, tail, headGap, headMuted } = classifyUnit(unit);
  const gap = headGap === "hair" ? "·" : "";
  const mark = headMuted ? "~" : "";
  return `${gap}${mark}${head}${tail}`;
}

describe("classifyUnit", () => {
  it("fuses glyph-modifier units and keeps them unmuted", () => {
    for (const unit of ["%", "°", "°C", "°F", "¢", "$"]) {
      expect(classifyUnit(unit)).toMatchObject({
        head: unit,
        tail: "",
        headGap: "none",
        headMuted: false,
      });
    }
  });

  it("hair-spaces and mutes alphabetic units", () => {
    for (const unit of [
      "W",
      "Wh",
      "kW",
      "kWh",
      "MW",
      "MWh",
      "GW",
      "GWh",
      "g",
      "kg",
      "A",
      "V",
      "Hz",
      "rpm",
      "kPa",
      "pp",
    ]) {
      expect(classifyUnit(unit)).toMatchObject({
        head: unit,
        tail: "",
        headGap: "hair",
        headMuted: true,
      });
    }
  });

  it("splits compound units at the first slash", () => {
    expect(render("¢/kWh")).toBe("¢/kWh"); // tight head, unmuted
    expect(render("c/kWh")).toBe("c/kWh"); // ASCII cents, also tight
    expect(render("$/MWh")).toBe("$/MWh");
    expect(render("g/kWh")).toBe("·~g/kWh"); // hair-spaced, muted head
    expect(render("kWh/d")).toBe("·~kWh/d");
    expect(render("pp/d")).toBe("·~pp/d");
  });

  it("handles a bare denominator (no head)", () => {
    expect(classifyUnit("/MWh")).toMatchObject({
      head: "",
      tail: "/MWh",
      headGap: "none",
      headMuted: false,
    });
  });

  it("handles the empty unit", () => {
    expect(classifyUnit("")).toMatchObject({ head: "", tail: "" });
  });

  it("keeps only the first slash in the head", () => {
    expect(classifyUnit("gCO₂e/kWh")).toMatchObject({
      head: "gCO₂e",
      tail: "/kWh",
      headGap: "hair",
      headMuted: true,
    });
  });
});

describe("isTightUnit", () => {
  it("is true for glyph modifiers and false for word symbols", () => {
    expect(isTightUnit("%")).toBe(true);
    expect(isTightUnit("°C")).toBe(true);
    expect(isTightUnit("kW")).toBe(false);
    expect(isTightUnit("rpm")).toBe(false);
  });
});
