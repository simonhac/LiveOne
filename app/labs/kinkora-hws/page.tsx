import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo } from "@/lib/db/planetscale/schema";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { modelHws, DEFAULT_HWS_MODEL_OPTIONS } from "@/lib/hws-model";
import { validateShareToken } from "@/lib/share-tokens";
import Timeline from "./Timeline";

const DAY_MS = 24 * 60 * 60 * 1000;
const DISPLAY_DAYS = 7;
const MODEL_WARMUP_DAYS = 2;
const MODEL_WINDOW_MS = (DISPLAY_DAYS + MODEL_WARMUP_DAYS) * DAY_MS;

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

  // Access check: a valid share token whose owner matches the system's owner
  // is sufficient. Otherwise fall back to Clerk auth (owner or admin).
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

  const hwsPoint = await requirePlanetscaleDb()
    .select()
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, system.id),
        eq(pointInfo.logicalPathStem, "load.hws"),
        eq(pointInfo.metricType, "power"),
      ),
    )
    .limit(1);

  if (hwsPoint.length === 0) {
    return (
      <main className="min-h-screen bg-gray-900 text-gray-100 p-8">
        <h1 className="text-xl font-semibold mb-2">Kinkora HWS</h1>
        <p className="text-red-400">
          No load.hws/power point found for system {system.id}.
        </p>
      </main>
    );
  }
  const pointIndex = hwsPoint[0].index;

  const tz = system.timezoneOffsetMin;
  const nowMs = Date.now();
  const startMs = nowMs - MODEL_WINDOW_MS;

  const todayLocalMidnightMs =
    Math.floor((nowMs + tz * 60_000) / DAY_MS) * DAY_MS - tz * 60_000;
  const displayStartMs = todayLocalMidnightMs - (DISPLAY_DAYS - 1) * DAY_MS;

  const result = await requirePlanetscaleDb().execute(sql`
        SELECT (EXTRACT(EPOCH FROM interval_end AT TIME ZONE 'UTC') * 1000) AS interval_end, avg
        FROM point_readings_agg_5m
        WHERE system_id = ${system.id} AND point_id = ${pointIndex}
          AND interval_end >= to_timestamp(${startMs} / 1000.0)
        ORDER BY interval_end ASC`);

  const samples = result.rows.map((r: any) => ({
    tsMs: Number(r.interval_end),
    powerW: r.avg === null ? null : Number(r.avg),
  }));

  const allSteps = modelHws(samples, DEFAULT_HWS_MODEL_OPTIONS);
  const steps = allSteps.filter((s) => s.tsMs >= displayStartMs);
  const latestFaucetC =
    allSteps.length > 0 ? allSteps[allSteps.length - 1].faucetC : null;

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
            No 5-minute data in the last {DISPLAY_DAYS} days.
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
