import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices, points } from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings";
import { Point, type PointId } from "@/lib/ids";
import { isUserAdmin } from "@/lib/auth-utils";
import { DEFAULT_HWS_MODEL_OPTIONS } from "@/lib/hws-model";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import { getDashboard } from "@/lib/dashboard/dashboards";
import DailyStripes from "@/components/dashboard/DailyStripes";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

const DAY_MS = 24 * 60 * 60 * 1000;
const DISPLAY_DAYS = 7;
const ON_THRESHOLD_W = DEFAULT_HWS_MODEL_OPTIONS.onThresholdW;

/**
 * The `load.hws` point for the given metric, as its identity, or null.
 *
 * Projects `point_uid` rather than the `index` this used to return: the readings seam keys on the
 * identity, so selecting the address and then resolving it back through
 * `RegistryCache.pointForAddr` was a round trip against the row we had already read
 * (config-v4 Phase 12 slice D).
 */
async function hwsPoint(
  systemId: number,
  metricType: string,
): Promise<PointId | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ pointUid: points.id })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(
        eq(devices.rid, systemId),
        eq(points.logicalPath, "load.hws"),
        eq(points.metricType, metricType),
      ),
    )
    .limit(1);
  return row ? Point.encode(row.pointUid) : null;
}

/**
 * Bounded read of a point's agg_5m avg over [fromMs, toMs] → Map<intervalEndMs, avg>.
 * The upper bound matters: 5m `intervalEnd = ceil(t/5min)*5min`, so the current in-progress
 * bucket is future-dated. Capping at `now` excludes it — mirroring the HWS recompute window
 * (lib/hws/recompute.ts), which only models completed buckets.
 */
async function readAgg5m(
  id: PointId,
  fromMs: number,
  toMs: number,
): Promise<Map<number, number | null>> {
  const m = new Map<number, number | null>();
  const series = await ReadingsDao.read5m([id], { fromMs, toMs });
  for (const r of series.get(id)!) m.set(r.intervalEndMs, r.avg);
  return m;
}

export default async function KinkoraHwsPage({
  searchParams,
}: {
  searchParams: Promise<{ access?: string }>;
}) {
  const { access } = await searchParams;

  const device = await DeviceConfigRegistry.deviceByUsernameAndSlug(
    "simon",
    "kinkora",
  );
  if (!device) notFound();

  // Access check: a valid (unified) dashboard share token whose dashboard is owned by the device's
  // owner is sufficient — config-v4 re-pointed the legacy owner-scoped token at an owner-wide
  // auto-created dashboard, so owner-match preserves the pre-cutover scope. Else fall back to Clerk auth.
  let viaShareToken = false;
  if (access) {
    const validated = await validateDashboardShareToken(access);
    if (validated) {
      const dash = await getDashboard(validated.dashboardId);
      if (dash && dash.ownerClerkUserId === device.ownerClerkUserId) {
        viaShareToken = true;
      }
    }
  }
  if (!viaShareToken) {
    const authResult = await auth();
    const { userId } = authResult;
    if (!userId) redirect("/sign-in");
    const isOwner = device.ownerClerkUserId === userId;
    const isAdmin = isOwner ? false : await isUserAdmin(authResult);
    if (!isOwner && !isAdmin) redirect("/dashboard");
  }

  const tempPoint = await hwsPoint(device.id, "temperature");
  const powerPoint = await hwsPoint(device.id, "power");
  if (tempPoint === null) {
    return (
      <main className="min-h-screen bg-gray-900 text-gray-100 p-8">
        <h1 className="text-xl font-semibold mb-2">Kinkora HWS</h1>
        <p className="text-red-400">
          No load.hws/temperature point for device {device.id}. Register it with
          scripts/seed-hws-point.ts.
        </p>
      </main>
    );
  }

  const tz = device.timezoneOffsetMin;
  const nowMs = Date.now();
  const todayLocalMidnightMs =
    Math.floor((nowMs + tz * 60_000) / DAY_MS) * DAY_MS - tz * 60_000;
  const displayStartMs = todayLocalMidnightMs - (DISPLAY_DAYS - 1) * DAY_MS;

  // Read the persisted modelled temperature + the source power (for the on/off row).
  // Cap at `now`: the in-progress 5m bucket is future-dated, and the model has not yet
  // produced a temperature for it — including it would surface a fabricated value.
  const tempByTs = await readAgg5m(tempPoint, displayStartMs, nowMs);
  const powerByTs =
    powerPoint !== null
      ? await readAgg5m(powerPoint, displayStartMs, nowMs)
      : new Map<number, number | null>();

  // Merge into the two series `DailyStripes` draws: the modelled temperature (coloured row) and
  // the source power (the thin on/off strip). Both are keyed on the UNION of timestamps, so a
  // slot present in either is "present" for the stripe — which is what the pre-extraction
  // Timeline's merged step list meant.
  const tsSet = new Set<number>([...tempByTs.keys(), ...powerByTs.keys()]);
  let prevFaucetC = DEFAULT_HWS_MODEL_OPTIONS.tFloor; // carry-forward for genuine gaps
  const faucetByTs = new Map<number, number | null>();
  const powerSeries = new Map<number, number | null>();
  for (const tsMs of [...tsSet].sort((a, b) => a - b)) {
    // Use the modelled temperature; for a power-only timestamp (a gap in the derived
    // series) carry the last modelled value forward rather than dropping to tFloor. The generic
    // card deliberately drops this carry-forward; the lab keeps it (docs/plans/hws-stripe-and-heatmap-cards.md).
    const faucetC = tempByTs.get(tsMs) ?? prevFaucetC;
    prevFaucetC = faucetC;
    faucetByTs.set(tsMs, faucetC);
    powerSeries.set(
      tsMs,
      powerByTs.has(tsMs) ? (powerByTs.get(tsMs) ?? null) : null,
    );
  }

  // The headline reflects the newest actually-modelled temperature (matches the dashboard's
  // KV latest), not the last merged step — which may be a power-only timestamp.
  const tempTimestamps = [...tempByTs.keys()].sort((a, b) => a - b);
  const latestTempTs = tempTimestamps[tempTimestamps.length - 1];
  const latestFaucetC =
    latestTempTs !== undefined ? (tempByTs.get(latestTempTs) ?? null) : null;

  return (
    <main className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">
          Kinkora HWS — Estimated{" "}
          {latestFaucetC === null ? "—" : `${latestFaucetC.toFixed(1)}°C`}
        </h1>

        <p className="text-sm text-gray-400 mb-6">
          Modelled hot-tap temperature based on HWS run-time.
        </p>

        {faucetByTs.size === 0 ? (
          <p className="text-gray-400">
            No modelled data in the last {DISPLAY_DAYS} days.
          </p>
        ) : (
          <DailyStripes
            values={faucetByTs}
            state={powerSeries}
            tz={tz}
            firstDayMidnightMs={displayStartMs}
            dayCount={DISPLAY_DAYS}
            domain={[
              DEFAULT_HWS_MODEL_OPTIONS.tFloor,
              DEFAULT_HWS_MODEL_OPTIONS.tFaucetMax,
            ]}
            palette={["hsl(210,80%,50%)", "hsl(0,80%,50%)"]}
            onThreshold={ON_THRESHOLD_W}
            unit="°C"
            label="Faucet"
          />
        )}
      </div>
    </main>
  );
}
