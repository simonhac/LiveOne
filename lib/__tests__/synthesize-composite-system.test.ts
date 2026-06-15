import { describe, it, expect } from "@jest/globals";
import {
  synthesizeCompositeSystem,
  type Area,
  type SystemWithPolling,
} from "@/lib/systems-manager";

// A composite Area row as stored in `areas` (kind='composite').
const compositeArea: Area = {
  id: "019ec06c-f74f-70c2-94b8-bd2c3dd28226",
  ownerClerkUserId: "user_craig",
  kind: "composite",
  sourceSystemId: null,
  legacySystemId: 7,
  displayName: "Craig Unified",
  alias: "craig",
  timezoneOffsetMin: 600,
  displayTimezone: "Australia/Brisbane",
  location: null,
  status: "active",
  createdAt: new Date("2026-06-13T00:00:00Z"),
  updatedAt: new Date("2026-06-13T00:00:00Z"),
};

describe("synthesizeCompositeSystem", () => {
  it("maps a composite Area onto an integer-keyed virtual system", () => {
    const s = synthesizeCompositeSystem(compositeArea) as SystemWithPolling;
    expect(s).not.toBeNull();
    expect(s.id).toBe(7); // the stable integer handle = legacy_system_id
    expect(s.vendorType).toBe("composite");
    expect(s.vendorSiteId).toBe("composite:7"); // unambiguous sentinel, no collision
    expect(s.displayName).toBe("Craig Unified");
    expect(s.ownerClerkUserId).toBe("user_craig");
    expect(s.alias).toBe("craig");
    expect(s.timezoneOffsetMin).toBe(600);
    expect(s.displayTimezone).toBe("Australia/Brisbane");
    expect(s.status).toBe("active");
    // Composites own no device/polling identity.
    expect(s.metadata).toBeNull();
    expect(s.pollingStatus).toBeNull();
    expect(s.model).toBeNull();
    expect(s.serial).toBeNull();
  });

  it("returns null when the Area has no legacy_system_id (no integer handle)", () => {
    expect(
      synthesizeCompositeSystem({ ...compositeArea, legacySystemId: null }),
    ).toBeNull();
  });
});
