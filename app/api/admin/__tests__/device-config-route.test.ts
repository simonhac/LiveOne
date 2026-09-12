/**
 * ROUTE-level tests for `PATCH /api/admin/devices/[systemId]/config`.
 *
 * The whole point of this file is ONE rule, which is invisible in the handler and expensive to
 * rediscover: **PATCH replaces `devices.config` wholesale**, so a field `parseDeviceConfig` does not
 * carry through is a field the next save DESTROYS. That is deliberate for the fields the editor owns
 * (setting a capability toggle back to "default" removes its key by omission) and catastrophic for the
 * ones it does not — `spec` and `batteryProvenance` have no editor anywhere, so nothing would put them
 * back.
 *
 * Observed 2026-09-12: `spec` was never parsed, so a single press of Save in the Device Config tab
 * would have erased Kutis's `{solarSizeKw: 11.9, batterySizeKwh: 32.24}` (and with it the chart y-axis
 * hint `maxPowerHintFromSpec` derives from it), and Daylesford's
 * `batteryProvenance.generatorSource` — the off-grid site's entire cost and emissions basis. Both are
 * silent: the PATCH answers 200 either way.
 *
 * So the assertions below are round-trip assertions, not field-by-field ones. If you add a field to
 * `DeviceConfig`, add it to `FULL_CONFIG` — a new field that does not survive `GET → PATCH` is the bug
 * this file exists to catch.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import type { DeviceConfig } from "@/lib/capabilities/config";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/registry/device-writer", () => ({
  DeviceWriter: { updateDevice: jest.fn() },
}));
jest.mock("@/lib/capabilities/server", () => ({
  derivedCapabilitiesForDevice: jest.fn(),
}));
jest.mock("@/lib/areas/config", () => ({
  syncAreaBatteryConfigFromDevice: jest.fn(),
}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

const { requireDeviceAccess } = jest.requireMock("@/lib/api-auth") as {
  requireDeviceAccess: jest.Mock;
};
const { DeviceWriter } = jest.requireMock("@/lib/registry/device-writer") as {
  DeviceWriter: { updateDevice: jest.Mock };
};
const { derivedCapabilitiesForDevice } = jest.requireMock(
  "@/lib/capabilities/server",
) as { derivedCapabilitiesForDevice: jest.Mock };

/** Every field `DeviceConfig` can carry, so the round-trip below is total over the type. */
const FULL_CONFIG: DeviceConfig = {
  capabilities: { "solar/power": true },
  spec: { solarSizeKw: 11.9, batterySizeKwh: 32.24 },
  nameplateKw: 10,
  updateCadenceSeconds: 300,
  batteryProvenance: {
    generatorSource: {
      emissionsIntensity: 1000,
      pricePerKwh: 45,
      renewableFraction: 0,
    },
    reserveFloorMaxPct: 12,
  },
};

const params = Promise.resolve({ systemId: "13" });

function patchWith(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/devices/13/config", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** What `DeviceWriter.updateDevice` was actually asked to persist. */
function persistedConfig(): DeviceConfig | null {
  const [, patch] = DeviceWriter.updateDevice.mock.calls.at(-1) as [
    number,
    { config: DeviceConfig | null },
  ];
  return patch.config;
}

describe("PATCH /api/admin/devices/[systemId]/config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requireDeviceAccess.mockResolvedValue({
      device: { config: FULL_CONFIG },
    } as never);
    derivedCapabilitiesForDevice.mockResolvedValue(new Set() as never);
    DeviceWriter.updateDevice.mockResolvedValue(undefined as never);
  });

  it("round-trips every DeviceConfig field — what GET returns, PATCH must persist unchanged", async () => {
    const { GET, PATCH } = await import(
      "@/app/api/admin/devices/[systemId]/config/route"
    );

    // GET is the only source a client has for the fields it cannot edit, so the round-trip has to
    // start there rather than from a hand-written literal.
    const getRes = await GET(
      new NextRequest("http://localhost/api/admin/devices/13/config"),
      { params },
    );
    const { config } = (await getRes.json()) as { config: DeviceConfig };

    const res = await PATCH(patchWith(config), { params });
    expect(res.status).toBe(200);
    expect(persistedConfig()).toEqual(FULL_CONFIG);
  });

  it("does not drop `spec` when the body carries it", async () => {
    const { PATCH } = await import(
      "@/app/api/admin/devices/[systemId]/config/route"
    );
    await PATCH(patchWith({ spec: { solarSizeKw: 11.9 } }), { params });
    expect(persistedConfig()).toEqual({ spec: { solarSizeKw: 11.9 } });
  });

  it("rejects a non-positive spec number rather than storing a 0 the legacy parse could never produce", async () => {
    const { PATCH } = await import(
      "@/app/api/admin/devices/[systemId]/config/route"
    );
    const res = await PATCH(patchWith({ spec: { solarSizeKw: 0 } }), {
      params,
    });
    expect(res.status).toBe(400);
    expect(DeviceWriter.updateDevice).not.toHaveBeenCalled();
  });

  it("omits `spec` entirely when every field is absent, rather than storing an empty object", async () => {
    const { PATCH } = await import(
      "@/app/api/admin/devices/[systemId]/config/route"
    );
    await PATCH(patchWith({ spec: {}, nameplateKw: 10 }), { params });
    expect(persistedConfig()).toEqual({ nameplateKw: 10 });
  });

  it("still clears a field by OMISSION — replacement is the contract, not a bug", async () => {
    const { PATCH } = await import(
      "@/app/api/admin/devices/[systemId]/config/route"
    );
    await PATCH(patchWith({ spec: { solarSizeKw: 11.9 } }), { params });
    // `capabilities`/`nameplateKw`/`batteryProvenance` were all set on the stored config and are all
    // absent from the body, so they are gone. This is how a toggle returns to "default".
    expect(persistedConfig()).toEqual({ spec: { solarSizeKw: 11.9 } });
  });

  it("answers 401/403 straight through when the auth gate refuses", async () => {
    const { PATCH } = await import(
      "@/app/api/admin/devices/[systemId]/config/route"
    );
    requireDeviceAccess.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }) as never,
    );
    const res = await PATCH(patchWith(FULL_CONFIG), { params });
    expect(res.status).toBe(403);
    expect(DeviceWriter.updateDevice).not.toHaveBeenCalled();
  });
});
