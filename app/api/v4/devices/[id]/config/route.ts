import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices as devicesTable } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { parseDeviceConfig } from "@/lib/capabilities/parse-config";
import {
  syncAreaBatteryConfigFromDevice,
  type AreaConfigSyncResult,
} from "@/lib/areas/config";
import { Device } from "@/lib/ids";

/**
 * `GET|PATCH /api/v4/devices/{id}/config` — read and write one device's `DeviceConfig` blob, for
 * `liveone device config`.
 *
 * A TypeID-native, CLI-reachable sibling of `/api/admin/devices/{systemId}/config`, which a
 * `lo_cli_` bearer cannot reach at all: `cliTokenRoutes` carries no `/api/admin` entry, deliberately
 * and twice-stated, so `auth.protect()` rewrites the request to a 404 at the edge before the handler
 * sees the token. Adding this address was preferred to widening that bypass to `/api/admin` — the
 * same call `/api/v4/devices/{id}/sync` made against `/api/admin/amber-sync`.
 *
 * 🛑 **No `lib/route-matchers.ts` change was needed, and that is load-bearing rather than lucky.**
 * `/api/v4/devices(.*)` is already one of the three wildcard entries in `cliTokenRoutes`, annotated
 * "every handler requireAuth's" — so this route inherited the bypass by being nested, and the
 * annotation is only true because of the `requireDeviceAccess` below. `lib/__tests__/cli-token-edge.test.ts`
 * enforces that for every route the matcher exposes; do not remove the auth call to "simplify".
 *
 * PATCH REPLACES the whole blob with `parseDeviceConfig`'s cleaned output (all-default → null),
 * exactly as the admin twin does — the two share the parser, so they cannot drift. That replacement
 * is what makes `liveone device config clean` work at all: the parser is a whitelist rebuild, so
 * PATCHing a stored config straight back through it evicts every key the parser no longer knows.
 *
 * 🛑 **The response reports the AREAS the mirror touched, and the CLI prints them.** `batteryProvenance`
 * is copied into `areas.config` for every area where this device is the preferred `battery/power`
 * binding, by a hand-written `sql` whose failure mode is silent under-resolution — zero areas updated,
 * no error, and `tsc` cannot see into it. A caller that assumes the mirror ran would cheerfully report
 * a config cleaned in one place and still rotten in the other.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolveDevice(params);
  if ("error" in resolved) return resolved.error;

  const auth = await requireDeviceAccess(request, resolved.systemId);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    ok: true,
    deviceId: Device.encode(resolved.uuid),
    systemId: resolved.systemId,
    config: auth.device.config ?? null,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolveDevice(params);
  if ("error" in resolved) return resolved.error;

  const auth = await requireDeviceAccess(request, resolved.systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const parsed = parseDeviceConfig(body);
  if ("error" in parsed)
    return NextResponse.json({ error: parsed.error }, { status: 400 });

  const before = auth.device.config ?? null;

  await DeviceWriter.updateDevice(resolved.systemId, {
    config: parsed.config,
  });
  const mirror: AreaConfigSyncResult = await syncAreaBatteryConfigFromDevice(
    resolved.systemId,
    parsed.config?.batteryProvenance,
  );

  // Capability eligibility is server-rendered (device viewer + dashboard seeds); refresh it, exactly
  // as the admin twin does.
  revalidatePath("/dashboard", "layout");
  revalidatePath("/device", "layout");

  return NextResponse.json({
    ok: true,
    deviceId: Device.encode(resolved.uuid),
    systemId: resolved.systemId,
    before,
    config: parsed.config,
    areas: mirror.areas,
  });
}

/**
 * Resolve `dv_…` (or a bare integer handle, which the CLI's own resolver may hand through) to the
 * pair every caller here needs. A device the caller cannot see is `requireDeviceAccess`'s problem,
 * not this function's — it resolves identity only.
 */
async function resolveDevice(
  params: Promise<{ id: string }>,
): Promise<{ uuid: string; systemId: number } | { error: NextResponse }> {
  const { id } = await params;
  const uuid = Device.toUuidOrNull(id);
  if (!uuid)
    return {
      error: NextResponse.json({ error: "Invalid device id" }, { status: 400 }),
    };
  const db = requirePlanetscaleDb();
  const [row] = await db
    .select({ rid: devicesTable.rid })
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);
  if (!row)
    return {
      error: NextResponse.json({ error: "Device not found" }, { status: 404 }),
    };
  return { uuid, systemId: row.rid };
}
