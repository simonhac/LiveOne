import { describe, it, expect } from "@jest/globals";
import { normalizeAlias, isValidAlias, MAX_ALIAS_LENGTH } from "../alias";

describe("normalizeAlias", () => {
  it("kebab-cases a human name", () => {
    expect(normalizeAlias("Home & Farm")).toBe("home-farm");
    expect(normalizeAlias("  My Dashboard  ")).toBe("my-dashboard");
    expect(normalizeAlias("Solar_Battery")).toBe("solar-battery");
  });

  it("collapses and trims hyphens", () => {
    expect(normalizeAlias("a---b")).toBe("a-b");
    expect(normalizeAlias("-leading-and-trailing-")).toBe(
      "leading-and-trailing",
    );
  });

  it("strips characters that can't appear in a URL slug", () => {
    // Whitespace/underscores become hyphens; any other non-[a-z0-9-] char is dropped.
    expect(normalizeAlias("Solar (kW) #1")).toBe("solar-kw-1");
    expect(normalizeAlias("café")).toBe("caf");
  });

  it("empty / punctuation-only input becomes empty (no alias)", () => {
    expect(normalizeAlias("")).toBe("");
    expect(normalizeAlias("   ")).toBe("");
    expect(normalizeAlias("!!!")).toBe("");
  });

  it("caps length and never leaves a dangling hyphen at the boundary", () => {
    const out = normalizeAlias("a".repeat(80) + "-tail");
    expect(out.length).toBeLessThanOrEqual(MAX_ALIAS_LENGTH);
    expect(out.endsWith("-")).toBe(false);
  });

  it("is idempotent and always produces a valid alias", () => {
    for (const raw of ["Home & Farm", "a---b", "café!!", "x".repeat(200)]) {
      const once = normalizeAlias(raw);
      expect(normalizeAlias(once)).toBe(once);
      expect(isValidAlias(once)).toBe(true);
    }
  });
});

describe("isValidAlias", () => {
  it("accepts kebab-case and empty (means no alias)", () => {
    expect(isValidAlias("")).toBe(true);
    expect(isValidAlias("home-farm")).toBe(true);
    expect(isValidAlias("sys2")).toBe(true);
  });

  it("rejects capitals, spaces, leading/trailing/double hyphens, and over-length", () => {
    expect(isValidAlias("Home")).toBe(false);
    expect(isValidAlias("home farm")).toBe(false);
    expect(isValidAlias("-home")).toBe(false);
    expect(isValidAlias("home-")).toBe(false);
    expect(isValidAlias("a--b")).toBe(false);
    expect(isValidAlias("a".repeat(MAX_ALIAS_LENGTH + 1))).toBe(false);
  });
});
