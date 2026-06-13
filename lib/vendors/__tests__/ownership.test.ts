import { describe, it, expect } from "@jest/globals";
import { isPublicSystem, vendorUsesAppCredentials } from "../ownership";

describe("vendorUsesAppCredentials", () => {
  it("is true for app-wide-credential vendors (openelectricity)", () => {
    expect(vendorUsesAppCredentials("openelectricity")).toBe(true);
    expect(vendorUsesAppCredentials("OpenElectricity")).toBe(true); // case-insensitive
  });

  it("is false for per-user vendors (incl. Enphase, which has no credentialFields but uses OAuth)", () => {
    expect(vendorUsesAppCredentials("amber")).toBe(false);
    expect(vendorUsesAppCredentials("enphase")).toBe(false);
    expect(vendorUsesAppCredentials("tesla")).toBe(false);
    expect(vendorUsesAppCredentials("selectronic")).toBe(false);
  });

  it("is false for null/undefined", () => {
    expect(vendorUsesAppCredentials(null)).toBe(false);
    expect(vendorUsesAppCredentials(undefined)).toBe(false);
  });
});

describe("isPublicSystem", () => {
  it("treats a null owner as public", () => {
    expect(isPublicSystem({ ownerClerkUserId: null })).toBe(true);
  });
  it("treats an owned system as not public", () => {
    expect(isPublicSystem({ ownerClerkUserId: "user_123" })).toBe(false);
  });
});
