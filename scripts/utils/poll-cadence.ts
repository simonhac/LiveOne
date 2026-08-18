#!/usr/bin/env tsx
/**
 * Fleet poll-cadence report — what the schedule actually does, as opposed to what it declares.
 *
 * Reconstructed from our OWN records (`sessions` for the polls, the 5m aggregate for the data), so
 * it is read-only and safe against prod. Two jobs:
 *
 *  1. **Standing health check.** Per device: polls/hour against the declared slot, gap percentiles,
 *     how often a poll lands on the minute it is due (slot start + offset), duration percentiles,
 *     failures, and the duplicate-minute count that betrays overlapping cron runs. The slot is PER DEVICE
 *     (`intervalFor`), not per vendor class, so a per-device override is reported as the cadence the
 *     scheduler actually uses; and on-slot is suppressed for vendors that deliberately poll inside
 *     their slot rather than on its boundary (`slotAlignment`).
 *
 *  2. **Before/after evidence for a scheduling change.** Run it, change the schedule, run it again.
 *
 * ⚠️ It deliberately does NOT try to measure each vendor's publication lag (the basis for
 * `pollOffsetMinutes`). The obvious proxy — `agg_5m.created_at − interval_end` — does not measure
 * it: `created_at` is when the ROW was first written, and a vendor whose fetch window extends past
 * `now` (OpenElectricity requests through `baseMs + 5min`) creates the row before the interval it
 * labels has closed, while a live-streaming vendor has its bucket created by the receiver on the
 * first sample. Both give a number that looks plausible and means something else. The one honest
 * measurement of NEM publish delay in this codebase is OpenElectricity's own EWMA learner
 * (`lib/vendors/openelectricity/scheduler.ts`), which times an actual capture against the interval
 * it captured — which is precisely why that learner was kept rather than replaced with a fixed
 * offset.
 *
 * Run it BEFORE and AFTER a scheduling change. Success looks like: p50 gap == the declared slot,
 * on-slot ≥ 95% (where it is measured at all), zero duplicate minutes.
 *
 * Usage:
 *   npm run poll-cadence
 *   npm run poll-cadence -- --hours=48
 *   npm run poll-cadence -- --device=9 --csv=.context/cadence.csv
 *
 * Against PROD (the dev mirror lags ~2h and never back-fills prod history):
 *   pscale role create liveone sydney cadence --inherited-roles pg_read_all_data --ttl 1h --format json
 *   PLANETSCALE_DATABASE_URL="<database_url>" npm run poll-cadence -- --hours=24
 *   pscale role delete liveone sydney <role-id> --force
 */

// `timestamp` columns here are naive UTC and node-pg parses them with the process timezone; on a
// Sydney laptop that shifts every reading by 10-11 h. Pin it before any Date exists.
process.env.TZ = "UTC";

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// Type-only: erased at compile time, so it can sit above the dotenv call that the runtime imports
// below are deliberately kept beneath.
import type { DeviceRecord } from "@/lib/registry";

const HOUR_MS = 3_600_000;
const AEST_OFFSET_MS = 10 * HOUR_MS;

interface Args {
  hours: number;
  deviceRid?: number;
  csv?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (n: string) =>
    argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const device = get("device");
  return {
    hours: Number(get("hours") ?? 24),
    deviceRid: device === undefined ? undefined : Number(device),
    csv: get("csv"),
  };
}

const aest = (ms: number) =>
  new Date(ms + AEST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
const num = (v: number | null, dp = 2, w = 7) =>
  (v === null || !Number.isFinite(v) ? "—" : v.toFixed(dp)).padStart(w);
const pct = (v: number | null, w = 6) =>
  (v === null || !Number.isFinite(v)
    ? "—"
    : `${(v * 100).toFixed(0)}%`
  ).padStart(w);

interface Row {
  rid: number;
  vendor: string;
  name: string;
  declaredSlotMin: number | null;
  declaredOffsetMin: number | null;
  /** `boundary` = on-slot is measured; `within-slot` = it is suppressed (see the vendor note). */
  slotAlignment: "boundary" | "within-slot";
  polls: number;
  failed: number;
  topError: string | null;
  pollsPerHour: number;
  gapP50: number | null;
  gapP90: number | null;
  gapMax: number | null;
  onSlot: number | null;
  durP50: number | null;
  durP90: number | null;
  durMax: number | null;
  duplicateMinutes: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const { sql } = await import("drizzle-orm");
  const { VendorRegistry } = await import("@/lib/vendors/registry");
  const { DeviceConfigRegistry } = await import("@/lib/registry");

  const db = requirePlanetscaleDb();
  const rowsOf = <T>(res: unknown): T[] =>
    ((res as { rows?: unknown[] }).rows ?? res) as T[];

  const toMs = Date.now();
  const fromMs = toMs - args.hours * HOUR_MS;
  const from = new Date(fromMs)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  // Real device records, not a three-column projection: `intervalFor` reads `adapter_state` (via
  // `metadata`) for the per-device overrides, so a device shorn of it reports the class default.
  // `activeDevices()` is already ORDER BY rid, and its inner join on `primary_area_id` (NOT NULL)
  // cannot drop a row.
  const active = await DeviceConfigRegistry.activeDevices();
  const devices =
    args.deviceRid === undefined
      ? active
      : active.filter((d) => d.id === args.deviceRid);

  console.log(
    `\nPoll cadence — last ${args.hours}h (${aest(fromMs)} → ${aest(toMs)} AEST)\n`,
  );

  const rows: Row[] = [];
  for (const device of devices) {
    // The declared schedule, read off the adapter so the report can never disagree with the code.
    // The scheduling surface is `protected` (it is not part of the `VendorAdapter` contract), so a
    // structural cast is how a read-only report gets at it without widening the adapter's API —
    // same trick as the minutely cron and monitor-observations.
    const adapter = VendorRegistry.getAdapter(device.vendorType) as unknown as {
      dataSource?: string;
      pollIntervalMinutes?: number;
      pollOffsetMinutes?: number;
      slotAlignment?: "boundary" | "within-slot";
      intervalFor?: (device: DeviceRecord) => number;
    } | null;
    if (!adapter || adapter.dataSource === "push") continue;

    // Per DEVICE, not per vendor class: Tesla's cadence comes from `adapter_state.tesla`
    // (`resolveTeslaConfig`), so rid 10's 12-minute override would otherwise be reported — and
    // scored — as the class default of 15.
    //
    // ⚠️ Tesla's `intervalFor` also consults an in-memory `chargingStates` map that is empty in a
    // fresh script process, so it returns the IDLE interval. That is the right number for this
    // report (the charging cadence is a transient the report can't reconstruct anyway), but it
    // means the column never shows 2 min for a car that happens to be charging right now.
    const slot =
      adapter.intervalFor?.(device) ?? adapter.pollIntervalMinutes ?? null;

    // Whether landing on the slot boundary is even the goal. OpenElectricity waits a learned
    // publication delay INSIDE its slot, so a boundary hit is impossible and the percentage can
    // only ever be 0 — report `—` rather than a number that looks like a fault.
    const alignment = adapter.slotAlignment ?? "boundary";
    const measureOnSlot = slot !== null && alignment === "boundary";
    // A boundary vendor is due at slot start + offset, so THAT is the minute to score against — not
    // slot start. Zero for every vendor today, which is what makes the change checkable: `(m - 0)`
    // reduces to the previous expression exactly. Without it, the first vendor to declare an offset
    // would score a permanent 0% for being precisely on time — defect 2 in a second costume.
    const offset = adapter.pollOffsetMinutes ?? 0;

    const [stats] = rowsOf<{
      polls: string;
      failed: string;
      per_hour: string;
      gap_p50: string | null;
      gap_p90: string | null;
      gap_max: string | null;
      on_slot: string | null;
      dur_p50: string | null;
      dur_p90: string | null;
      dur_max: string | null;
      top_error: string | null;
      dup_minutes: string;
    }>(
      await db.execute(sql`
        WITH s AS (
          SELECT created_at, duration, successful,
                 lag(created_at) OVER (ORDER BY created_at) AS prev
          FROM sessions
          WHERE device_rid = ${device.id} AND cause = 'CRON'
            AND created_at >= ${from}::timestamp
        )
        SELECT count(*) AS polls,
               count(*) FILTER (WHERE NOT successful) AS failed,
               count(*) / ${args.hours}::float AS per_hour,
               percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY extract(epoch FROM (created_at - prev)) / 60) AS gap_p50,
               percentile_cont(0.9) WITHIN GROUP (
                 ORDER BY extract(epoch FROM (created_at - prev)) / 60) AS gap_p90,
               max(extract(epoch FROM (created_at - prev)) / 60) AS gap_max,
               ${
                 measureOnSlot
                   ? // Doubled modulo: Postgres `%` keeps the sign of the dividend, so a poll in the
                     // first `offset` minutes of the hour would otherwise land on a negative
                     // remainder and never compare equal to 0.
                     sql`avg(CASE WHEN ((extract(minute FROM created_at)::int - ${offset}) % ${slot}
                                        + ${slot}) % ${slot} = 0
                                  THEN 1.0 ELSE 0.0 END)`
                   : sql`NULL::float`
               } AS on_slot,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY duration) AS dur_p50,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY duration) AS dur_p90,
               max(duration) AS dur_max,
               (SELECT left(e.error, 60) FROM sessions e
                 WHERE e.device_rid = ${device.id} AND NOT e.successful
                   AND e.error IS NOT NULL AND e.created_at >= ${from}::timestamp
                 GROUP BY left(e.error, 60) ORDER BY count(*) DESC LIMIT 1) AS top_error,
               (SELECT count(*) FROM (
                  SELECT 1 FROM sessions d
                   WHERE d.device_rid = ${device.id} AND d.cause = 'CRON'
                     AND d.created_at >= ${from}::timestamp
                   GROUP BY date_trunc('minute', d.created_at)
                   HAVING count(*) > 1) x) AS dup_minutes
        FROM s`),
    );

    rows.push({
      rid: device.id,
      vendor: device.vendorType,
      name: device.displayName,
      declaredSlotMin: slot,
      declaredOffsetMin: offset,
      slotAlignment: alignment,
      polls: Number(stats?.polls ?? 0),
      failed: Number(stats?.failed ?? 0),
      topError: stats?.top_error ?? null,
      pollsPerHour: Number(stats?.per_hour ?? 0),
      gapP50: stats?.gap_p50 === null ? null : Number(stats?.gap_p50),
      gapP90: stats?.gap_p90 === null ? null : Number(stats?.gap_p90),
      gapMax: stats?.gap_max === null ? null : Number(stats?.gap_max),
      onSlot: stats?.on_slot === null ? null : Number(stats?.on_slot),
      durP50: stats?.dur_p50 === null ? null : Number(stats?.dur_p50),
      durP90: stats?.dur_p90 === null ? null : Number(stats?.dur_p90),
      durMax: stats?.dur_max === null ? null : Number(stats?.dur_max),
      duplicateMinutes: Number(stats?.dup_minutes ?? 0),
    });
  }

  console.log(
    "  rid  vendor            slot  off   polls/h  gap p50  gap p90  gap max  on-slot  dur p50  dur p90  dur max  fail  dup",
  );
  for (const r of rows) {
    console.log(
      `  ${String(r.rid).padStart(3)}  ${r.vendor.padEnd(16)} ` +
        `${String(r.declaredSlotMin ?? "—").padStart(4)}  ${String(r.declaredOffsetMin).padStart(3)}  ` +
        `${num(r.pollsPerHour, 2, 8)}  ${num(r.gapP50)}  ${num(r.gapP90)}  ${num(r.gapMax, 1)}  ` +
        `${pct(r.onSlot, 7)}  ${num(r.durP50, 0)}  ${num(r.durP90, 0)}  ${num(r.durMax, 0)}  ` +
        `${String(r.failed).padStart(4)}  ${String(r.duplicateMinutes).padStart(3)}`,
    );
  }

  console.log(
    "\n  Expected polls/h = 60 / slot, where slot is this DEVICE's interval (Tesla overrides it",
  );
  console.log(
    "  per device). A p50 gap above the slot means polls are being missed or deferred; on-slot",
  );
  console.log("  below ~95% means the phase is drifting.");

  for (const vendor of [
    ...new Set(
      rows
        .filter((r) => r.slotAlignment === "within-slot")
        .map((r) => r.vendor),
    ),
  ]) {
    console.log(
      `\n  on-slot is — for ${vendor}: it declares slotAlignment "within-slot", so its isEligible`,
    );
    console.log(
      `  gate (lib/vendors/${vendor}/adapter.ts) chooses a moment INSIDE the slot rather than its`,
    );
    console.log(
      "  boundary. A boundary hit is impossible; the percentage could only ever read 0.",
    );
  }
  console.log("");

  const problems = rows.filter(
    (r) =>
      r.duplicateMinutes > 0 ||
      (r.declaredSlotMin !== null &&
        r.gapP50 !== null &&
        r.gapP50 > r.declaredSlotMin * 1.2),
  );
  if (problems.length > 0) {
    console.log("\n  ⚠ Off-cadence:");
    for (const r of problems) {
      const bits: string[] = [];
      if (r.duplicateMinutes > 0)
        bits.push(
          `${r.duplicateMinutes} duplicate minute(s) — overlapping cron runs`,
        );
      if (r.declaredSlotMin && r.gapP50 && r.gapP50 > r.declaredSlotMin * 1.2)
        bits.push(
          `p50 gap ${r.gapP50.toFixed(2)} min vs a ${r.declaredSlotMin} min slot`,
        );
      console.log(`      ${r.rid} ${r.vendor}: ${bits.join("; ")}`);
      if (r.topError) console.log(`         most common error: ${r.topError}`);
    }
    process.exitCode = 1;
  } else {
    console.log("\n  ✓ every device on cadence, no duplicate minutes.");
  }

  if (args.csv) {
    const header = Object.keys(rows[0] ?? {}).join(",");
    const body = rows.map((r) =>
      Object.values(r)
        .map((v) =>
          typeof v === "string" && v.includes(",") ? JSON.stringify(v) : v,
        )
        .join(","),
    );
    mkdirSync(dirname(args.csv), { recursive: true });
    writeFileSync(args.csv, [header, ...body].join("\n") + "\n");
    console.log(`\nwrote ${args.csv}`);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
