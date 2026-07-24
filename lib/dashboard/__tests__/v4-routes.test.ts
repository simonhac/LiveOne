import { describe, it, expect } from "@jest/globals";
import { parseIfMatch } from "../v4-routes";

describe("parseIfMatch", () => {
  it('parses a quoted revision (`"17"`)', () => {
    expect(parseIfMatch('"17"')).toBe(17);
  });
  it("parses a bare revision", () => {
    expect(parseIfMatch("17")).toBe(17);
    expect(parseIfMatch(" 42 ")).toBe(42);
  });
  it("returns undefined for missing/garbage", () => {
    expect(parseIfMatch(null)).toBeUndefined();
    expect(parseIfMatch("")).toBeUndefined();
    expect(parseIfMatch("not-a-number")).toBeUndefined();
  });
});
