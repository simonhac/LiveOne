import { describe, it, expect } from "@jest/globals";
import { applyExcelFormat } from "../excel-format";
import { resolvePointDisplay } from "../registry";

describe("applyExcelFormat", () => {
  it("formats fixed decimals", () => {
    expect(applyExcelFormat(50, "0.0")).toBe("50.0");
    expect(applyExcelFormat(50, "0")).toBe("50");
    expect(applyExcelFormat(14.03, "0.0")).toBe("14.0");
    expect(applyExcelFormat(1.5, "0.00")).toBe("1.50");
    expect(applyExcelFormat(49.96, "0.0")).toBe("50.0"); // rounds
  });

  it("groups thousands", () => {
    expect(applyExcelFormat(12345, "#,##0")).toBe("12,345");
    expect(applyExcelFormat(12345.6, "#,##0.0")).toBe("12,345.6");
    expect(applyExcelFormat(-12345, "#,##0")).toBe("-12,345");
    expect(applyExcelFormat(999, "#,##0")).toBe("999");
  });

  it("formats percent", () => {
    expect(applyExcelFormat(0.5, "0%")).toBe("50%");
    expect(applyExcelFormat(0.5, "0.0%")).toBe("50.0%");
  });

  it("falls back to String(value) with no format", () => {
    expect(applyExcelFormat(5)).toBe("5");
    expect(applyExcelFormat(5, null)).toBe("5");
    expect(applyExcelFormat(1.25, undefined)).toBe("1.25");
  });

  it("handles NaN safely", () => {
    expect(applyExcelFormat(NaN, "0.0")).toBe("");
  });
});

describe("resolvePointDisplay", () => {
  it("resolves deepsea generator points", () => {
    expect(resolvePointDisplay("deepsea", "generator", "gen_freq_hz")).toEqual({
      unit: "Hz",
      format: "0.0",
    });
    expect(resolvePointDisplay("deepsea", "generator", "battery_v")).toEqual({
      unit: "V",
      format: "0.0",
    });
    expect(resolvePointDisplay("deepsea", "generator", "engine_rpm")).toEqual({
      unit: "rpm",
      format: "0",
    });
  });

  it("returns null for uncovered points/vendors/missing keys", () => {
    expect(resolvePointDisplay("deepsea", "generator", "nope")).toBeNull();
    expect(
      resolvePointDisplay("selectronic", "generator", "battery_v"),
    ).toBeNull();
    expect(resolvePointDisplay("deepsea", null, "battery_v")).toBeNull();
    expect(resolvePointDisplay(null, "generator", "battery_v")).toBeNull();
  });
});
