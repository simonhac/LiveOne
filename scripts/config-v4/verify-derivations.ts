#!/usr/bin/env tsx
/**
 * config-v4 Phase 11 verification: prove `derived_intervals` is byte-identical to the
 * `device_run_periods` it replaced. READ-ONLY.
 *
 * This is the phase gate. A re-key that loses or subtly alters a stat column would corrupt derived
 * daily history silently, so every legacy row is joined to its new counterpart through the
 * (system, role) → derivation mapping and compared column by column — plus a full outer check, so
 * an interval with no legacy twin (or vice versa) is reported rather than passing unnoticed.
 *
 * Post-deploy, the live writer legitimately moves the trailing window. Pass
 * `--before=<ISO timestamp>` to restrict the comparison to intervals starting before the deploy
 * (typically deploy − 6h, the reconcile window), so healed rows don't read as diffs.
 *
 * Usage:
 *   CONFIG_V4_TARGET=dev npx tsx --env-file=.env.local scripts/config-v4/verify-derivations.ts
 *   … scripts/config-v4/verify-derivations.ts --before=2026-07-28T00:00:00Z
 */
import { assertRehearsalTarget } from "./guard";

assertRehearsalTarget();

import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  derivations,
  derivedIntervals,
  deviceRunPeriods,
  deviceTrackers,
} from "@/lib/db/planetscale/schema";
import { deriveDerivationId } from "@/lib/derivations/ids";
import {
  RUN_DETECTOR_KIND,
  resolveAreaIdForHandle,
} from "@/lib/derivations/resolve";

const beforeArg = process.argv.find((a) => a.startsWith("--before="));
const BEFORE_MS = beforeArg ? Date.parse(beforeArg.split("=")[1]) : null;
if (beforeArg && Number.isNaN(BEFORE_MS)) {
  throw new Error(`Invalid --before: ${beforeArg}`);
}

/** The stat columns that must survive the re-key untouched. */
const COMPARED = [
  "endTime",
  "durationSeconds",
  "energyKwh",
  "maxPowerW",
  "minPowerW",
  "avgPowerW",
  "sampleCount",
  "detectorVersion",
] as const;

function norm(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

async function main() {
  const db = requirePlanetscaleDb();
  let diffs = 0;
  let compared = 0;

  const trackers = await db.select().from(deviceTrackers);
  if (trackers.length === 0) {
    console.log(
      "No device_trackers rows — nothing to compare (already dropped?).",
    );
  }

  const seenDerivations = new Set<string>();
  // Read each table once; these are hundreds of rows, and re-scanning per tracker is pointless.
  const allLegacy = await db.select().from(deviceRunPeriods);
  const allLive = await db.select().from(derivedIntervals);

  for (const t of trackers) {
    const areaId = await resolveAreaIdForHandle(t.systemId);
    if (!areaId) {
      console.error(`✗ tracker ${t.id}: no resolvable area for ${t.systemId}`);
      diffs += 1;
      continue;
    }
    const derivationId = deriveDerivationId(areaId, RUN_DETECTOR_KIND, t.role);
    seenDerivations.add(derivationId);

    const [derivation] = await db
      .select()
      .from(derivations)
      .where(eq(derivations.id, derivationId));
    if (!derivation) {
      console.error(
        `✗ ${t.systemId}/${t.role}: no derivation ${derivationId} — the fill did not run`,
      );
      diffs += 1;
      continue;
    }

    const legacy = allLegacy.filter(
      (r) =>
        r.systemId === t.systemId &&
        r.role === t.role &&
        (BEFORE_MS === null || r.startTime.getTime() < BEFORE_MS),
    );
    const live = allLive.filter(
      (r) =>
        r.derivationId === derivationId &&
        (BEFORE_MS === null || r.startTime.getTime() < BEFORE_MS),
    );

    const liveByStart = new Map(
      live.map((r) => [r.startTime.toISOString(), r] as const),
    );
    for (const l of legacy) {
      const key = l.startTime.toISOString();
      const m = liveByStart.get(key);
      if (!m) {
        console.error(
          `✗ ${t.systemId}/${t.role} ${key}: missing in derived_intervals`,
        );
        diffs += 1;
        continue;
      }
      liveByStart.delete(key);
      compared += 1;
      for (const col of COMPARED) {
        const a = norm((l as Record<string, unknown>)[col]);
        const b = norm((m as Record<string, unknown>)[col]);
        if (a !== b) {
          console.error(`✗ ${t.systemId}/${t.role} ${key}: ${col} ${a} → ${b}`);
          diffs += 1;
        }
      }
    }
    for (const orphanKey of liveByStart.keys()) {
      console.error(
        `✗ ${t.systemId}/${t.role} ${orphanKey}: in derived_intervals with no device_run_periods twin`,
      );
      diffs += 1;
    }

    console.log(
      `  ${t.systemId}/${t.role}: ${legacy.length} legacy vs ${live.length} live interval(s)`,
    );
  }

  // Intervals hanging off a derivation no tracker maps to would be invisible above.
  const stray = allLive.filter(
    (r) =>
      !seenDerivations.has(r.derivationId) &&
      (BEFORE_MS === null || r.startTime.getTime() < BEFORE_MS),
  );
  if (stray.length > 0) {
    const ids = [...new Set(stray.map((s) => s.derivationId))];
    console.error(
      `✗ ${stray.length} interval(s) on ${ids.length} derivation(s) with no legacy tracker: ${ids.join(", ")}`,
    );
    diffs += stray.length;
  }

  console.log(
    `\n${diffs === 0 ? "✓ PASS" : "✗ FAIL"} — ${compared} interval(s) compared, ${diffs} difference(s)` +
      (BEFORE_MS
        ? ` (restricted to starts before ${new Date(BEFORE_MS).toISOString()})`
        : ""),
  );
  process.exit(diffs === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
