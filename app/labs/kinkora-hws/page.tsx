import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { and, asc, eq, gte } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo, pointReadingsAgg5m } from "@/lib/db/planetscale/schema";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { DEFAULT_HWS_MODEL_OPTIONS, type HwsModelStep } from "@/lib/hws-model";
import { validateShareToken } from "@/lib/share-tokens";
import Timeline from "./Timeline";

const DAY_MS = 24 * 60 * 60 * 1000;
const DISPLAY_DAYS = 7;
const ON_THRESHOLD_W = DEFAULT_HWS_MODEL_OPTIONS.onThresholdW;

/** The point index for the `load.hws` stem + given metric, or null. */
async function hwsPointIndex(
  systemId: number,
  metricType: string,
): Promise<number | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ index: pointInfo.index })
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        eq(pointInfo.logicalPathStem, "load.hws"),
        eq(pointInfo.metricType, metricType),
      ),
    )
    .limit(1);
  return row ? row.index : null;
}

/** Bounded read of a point's agg_5m avg over [fromMs, now] → Map<intervalEndMs, avg>. */
async function readAgg5m(
  systemId: number,
  pointId: number,
  fromMs: number,
): Promise<Map<number, number | null>> {
  const rows = await requirePlanetscaleDb()
    .select({
      intervalEnd: pointReadingsAgg5m.intervalEnd,
      avg: pointReadingsAgg5m.avg,
    })
    .from(pointReadingsAgg5m)
    .where(
      and(
        eq(pointReadingsAgg5m.systemId, systemId),
        eq(pointReadingsAgg5m.pointId, pointId),
        gte(pointReadingsAgg5m.intervalEnd, new Date(fromMs)),
      ),
    )
    .orderBy(asc(pointReadingsAgg5m.intervalEnd));
  const m = new Map<number, number | null>();
  for (const r of rows) m.set(r.intervalEnd.getTime(), r.avg);
  return m;
}

export default async function KinkoraHwsPage({
  searchParams,
}: {
  searchParams: Promise<{ access?: string }>;
}) {
  const { access } = await searchParams;

  const systemsManager = SystemsManager.getInstance();
  const system = await systemsManager.getSystemByUsernameAndAlias(
    "simon",
    "kinkora",
  );
  if (!system) notFound();

  // Access check: a valid share token whose owner matches the system's owner is sufficient.
  // Otherwise fall back to Clerk auth (owner or admin).
  let viaShareToken = false;
  if (access) {
    const validated = await validateShareToken(access);
    if (validated && validated.ownerClerkUserId === system.ownerClerkUserId) {
      viaShareToken = true;
    }
  }
  if (!viaShareToken) {
    const authResult = await auth();
    const { userId } = authResult;
    if (!userId) redirect("/sign-in");
    const isOwner = system.ownerClerkUserId === userId;
    const isAdmin = isOwner ? false : await isUserAdmin(authResult);
    if (!isOwner && !isAdmin) redirect("/dashboard");
  }

  const tempPointId = await hwsPointIndex(system.id, "temperature");
  const powerPointId = await hwsPointIndex(system.id, "power");
  if (tempPointId === null) {
    return (
      <main className="min-h-screen bg-gray-900 text-gray-100 p-8">
        <h1 className="text-xl font-semibold mb-2">Kinkora HWS</h1>
        <p className="text-red-400">
          No load.hws/temperature point for system {system.id}. Register it with
          scripts/seed-hws-point.ts.
        </p>
      </main>
    );
  }

  const tz = system.timezoneOffsetMin;
  const nowMs = Date.now();
  const todayLocalMidnightMs =
    Math.floor((nowMs + tz * 60_000) / DAY_MS) * DAY_MS - tz * 60_000;
  const displayStartMs = todayLocalMidnightMs - (DISPLAY_DAYS - 1) * DAY_MS;

  // Read the persisted modelled temperature + the source power (for the on/off row).
  const tempByTs = await readAgg5m(system.id, tempPointId, displayStartMs);
  const powerByTs =
    powerPointId !== null
      ? await readAgg5m(system.id, powerPointId, displayStartMs)
      : new Map<number, number | null>();

  const tsSet = new Set<number>([...tempByTs.keys(), ...powerByTs.keys()]);
  const steps: HwsModelStep[] = [...tsSet]
    .sort((a, b) => a - b)
    .map((tsMs) => {
      const faucetC = tempByTs.get(tsMs) ?? DEFAULT_HWS_MODEL_OPTIONS.tFloor;
      const powerW = powerByTs.has(tsMs) ? (powerByTs.get(tsMs) ?? null) : null;
      return {
        tsMs,
        powerW,
        on: powerW !== null && powerW > ON_THRESHOLD_W,
        tankC: faucetC, // tank not persisted; unused by the Timeline
        faucetC,
      };
    });

  const latestFaucetC =
    steps.length > 0 ? steps[steps.length - 1].faucetC : null;

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

        {steps.length === 0 ? (
          <p className="text-gray-400">
            No modelled data in the last {DISPLAY_DAYS} days.
          </p>
        ) : (
          <Timeline
            steps={steps}
            tz={tz}
            firstDayMidnightMs={displayStartMs}
            dayCount={DISPLAY_DAYS}
          />
        )}
      </div>
    </main>
  );
}
