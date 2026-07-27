#!/usr/bin/env tsx
/**
 * config-v4 Phase 11 fill: `device_trackers` → `derivations`, `device_run_periods` →
 * `derived_intervals`, plus the `hws-model` derivation for every HWS point pair.
 *
 * A script rather than a migration because it must resolve handles through `legacy_handles` /
 * `devices.primary_area_id`, mint deterministic ids, and — the load-bearing part — be runnable at an
 * operator-chosen moment relative to the deploy, and re-runnable if that moment turns out wrong.
 *
 * IDEMPOTENT. Derivation ids are deterministic (uuidv5 over area/kind/role), so re-running upserts
 * in place; intervals are rebuilt per derivation inside one transaction (delete-then-insert), so the
 * open-interval partial unique is never transiently violated.
 *
 * ⚠️ RUN IT BEFORE THE DEPLOY, NOT AFTER. Once the new build is live it writes `derived_intervals`
 *    directly and the legacy table freezes; re-running the fill would then overwrite fresh intervals
 *    with a stale snapshot. The script refuses when it detects that (see `assertNotAlreadyLive`).
 *    The fill→deploy gap is healed by the first minutely reconcile (6h trailing window).
 *
 * SAFETY: dry run by default — pass --apply to write. Target selection is the shared config-v4
 * fail-closed guard (CONFIG_V4_TARGET=dev|prod; prod also needs --i-understand-this-is-prod).
 *
 * Usage:
 *   CONFIG_V4_TARGET=dev npx tsx --env-file=.env.local scripts/config-v4/fill-derivations.ts
 *   CONFIG_V4_TARGET=dev npx tsx --env-file=.env.local scripts/config-v4/fill-derivations.ts --apply
 */
import { assertRehearsalTarget } from "./guard";

assertRehearsalTarget();

import { and, eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  derivations,
  derivedIntervals,
  deviceRunPeriods,
  deviceTrackers,
  pointInfo,
} from "@/lib/db/planetscale/schema";
import {
  mapRunPeriodToInterval,
  mapTrackerToDerivation,
  type LegacyTrackerRow,
} from "@/lib/derivations/fill-map";
import { deriveDerivationId } from "@/lib/derivations/ids";
import {
  HWS_MODEL_KIND,
  resolveAreaIdForHandle,
} from "@/lib/derivations/resolve";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";

/**
 * Refuse to clobber a live cutover. If any interval is newer than everything in the legacy table,
 * the new build is already writing and this snapshot is stale.
 */
async function assertNotAlreadyLive() {
  const db = requirePlanetscaleDb();
  const [{ legacyMax } = { legacyMax: null }] = await db
    .select({ legacyMax: sql<Date | null>`max(${deviceRunPeriods.updatedAt})` })
    .from(deviceRunPeriods);
  const [{ liveMax } = { liveMax: null }] = await db
    .select({ liveMax: sql<Date | null>`max(${derivedIntervals.updatedAt})` })
    .from(derivedIntervals);
  if (liveMax && (!legacyMax || liveMax > legacyMax)) {
    throw new Error(
      `REFUSING: derived_intervals holds rows newer (${liveMax.toISOString()}) than device_run_periods ` +
        `(${legacyMax ? legacyMax.toISOString() : "empty"}). The new build is already writing — ` +
        `re-running the fill would overwrite live data with a stale snapshot. Heal the gap with the ` +
        `derivations cron instead (action=aggregate&last=1d).`,
    );
  }
}

async function main() {
  const db = requirePlanetscaleDb();
  await assertNotAlreadyLive();

  // (system_id, index) → point_uid, for the legacy int point addresses on the tracker rows.
  const points = await db
    .select({
      systemId: pointInfo.systemId,
      index: pointInfo.index,
      pointUid: pointInfo.pointUid,
    })
    .from(pointInfo);
  const uidByAddr = new Map(
    points.map((p) => [`${p.systemId}:${p.index}`, p.pointUid] as const),
  );
  const pointUid = (systemId: number, index: number) =>
    uidByAddr.get(`${systemId}:${index}`) ?? null;

  // ---- Leg 1: device_trackers → derivations -------------------------------
  const trackers = (await db
    .select()
    .from(deviceTrackers)) as LegacyTrackerRow[];
  console.log(`${tag} ${trackers.length} device_trackers row(s)`);

  const mapped: {
    derivation: ReturnType<typeof mapTrackerToDerivation>;
    systemId: number;
    role: string;
  }[] = [];
  for (const t of trackers) {
    const areaId = await resolveAreaIdForHandle(t.systemId);
    if (!areaId) {
      throw new Error(
        `REFUSING: tracker ${t.id} (system ${t.systemId}) has no resolvable area — ` +
          `legacy_handles has neither an area nor a device with a primary_area_id for that handle.`,
      );
    }
    const derivation = mapTrackerToDerivation(t, areaId, pointUid);
    mapped.push({ derivation, systemId: t.systemId, role: t.role });
    console.log(
      `  ${t.systemId}/${t.role} → derivation ${derivation.id} area=${areaId} ` +
        `params=${JSON.stringify(derivation.params)} source=${JSON.stringify(derivation.sourcePoints)}`,
    );
  }

  // `derivations_area_role_unique` is (area_id, role) — but the legacy unique was
  // (system_id, role), and two handles can resolve to the SAME area. Catch that here, in the dry
  // run, rather than as an opaque 23505 halfway through the write.
  const byAreaRole = new Map<string, number[]>();
  for (const m of mapped) {
    const key = `${m.derivation.areaId}:${m.role}`;
    byAreaRole.set(key, [...(byAreaRole.get(key) ?? []), m.systemId]);
  }
  for (const [key, systems] of byAreaRole) {
    if (systems.length > 1) {
      throw new Error(
        `REFUSING: trackers on systems ${systems.join(", ")} all resolve to ${key}, but only one ` +
          `derivation can hold an (area, role). Resolve the duplicate before filling.`,
      );
    }
  }

  // ---- Leg 3 (mapped before writing so a dry run reports everything) -------
  // Every active load.hws temperature point + its power sibling becomes an hws-model derivation.
  const hwsPoints = await db
    .select({
      systemId: pointInfo.systemId,
      metricType: pointInfo.metricType,
      pointUid: pointInfo.pointUid,
      displayName: pointInfo.displayName,
    })
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.logicalPathStem, "load.hws"),
        eq(pointInfo.active, true),
      ),
    );
  const bySystem = new Map<number, typeof hwsPoints>();
  for (const p of hwsPoints) {
    if (!bySystem.has(p.systemId)) bySystem.set(p.systemId, []);
    bySystem.get(p.systemId)!.push(p);
  }
  const hwsRows: {
    id: string;
    areaId: string;
    kind: string;
    role: null;
    name: string;
    enabled: boolean;
    output: string;
    outputPointId: string;
    params: Record<string, never>;
    sourcePoints: { power: string };
  }[] = [];
  for (const [systemId, pts] of bySystem) {
    const power = pts.find((p) => p.metricType === "power");
    const temp = pts.find((p) => p.metricType === "temperature");
    if (!power || !temp) continue; // a lone power point is a system without the model — skip
    const areaId = await resolveAreaIdForHandle(systemId);
    if (!areaId) {
      throw new Error(
        `REFUSING: HWS system ${systemId} has no resolvable area — cannot place its derivation.`,
      );
    }
    const id = deriveDerivationId(areaId, HWS_MODEL_KIND, null);
    hwsRows.push({
      id,
      areaId,
      kind: HWS_MODEL_KIND,
      role: null,
      name: temp.displayName,
      enabled: true,
      output: "point",
      outputPointId: temp.pointUid,
      params: {},
      sourcePoints: { power: power.pointUid },
    });
    console.log(`  hws system ${systemId} → derivation ${id} area=${areaId}`);
  }

  // ---- Leg 2: device_run_periods → derived_intervals -----------------------
  const periods = await db.select().from(deviceRunPeriods);
  const byKey = new Map<string, typeof periods>();
  for (const p of periods) {
    const key = `${p.systemId}:${p.role}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(p);
  }
  for (const [key, rows] of byKey) {
    if (!mapped.some((m) => `${m.systemId}:${m.role}` === key)) {
      throw new Error(
        `REFUSING: ${rows.length} run period(s) for ${key} have no matching device_trackers row — ` +
          `they would be silently dropped.`,
      );
    }
  }
  console.log(
    `${tag} ${periods.length} run period(s) across ${byKey.size} (system, role) key(s)`,
  );

  // ---- Pre-existing rows from the cutover transform ------------------------
  // The config-v4 cutover ALREADY wrote these rows (same shape, but RANDOM v4 ids, minted
  // independently per environment). Left alone they break the by-PK prod→dev sync — two
  // environments, two ids, duplicate rows, and a `derivations_area_role_unique` violation. So the
  // fill also NORMALIZES: any row for the same (area, kind, role) under a non-deterministic id is
  // deleted and re-inserted under the deterministic one. Safe precisely because `device_run_periods`
  // is still present to rebuild the intervals from — which is why this must run BEFORE the drop.
  const wanted = new Map<string, string>(); // "area:kind:role" → deterministic id
  for (const m of mapped) {
    wanted.set(
      `${m.derivation.areaId}:${m.derivation.kind}:${m.derivation.role ?? ""}`,
      m.derivation.id,
    );
  }
  for (const h of hwsRows) {
    wanted.set(`${h.areaId}:${h.kind}:`, h.id);
  }
  const existing = await db.select().from(derivations);
  const strays = existing.filter((e) => {
    const want = wanted.get(`${e.areaId}:${e.kind}:${e.role ?? ""}`);
    return want !== undefined && want !== e.id;
  });
  for (const s of strays) {
    console.log(
      `  re-key ${s.kind}${s.role ? `/${s.role}` : ""} ${s.id} → ${wanted.get(`${s.areaId}:${s.kind}:${s.role ?? ""}`)}`,
    );
  }
  const orphans = existing.filter(
    (e) => !wanted.has(`${e.areaId}:${e.kind}:${e.role ?? ""}`),
  );
  for (const o of orphans) {
    console.warn(
      `  ⚠️ derivation ${o.id} (${o.kind}/${o.role ?? "—"}, area ${o.areaId}) has no legacy source — LEFT ALONE`,
    );
  }

  if (!APPLY) {
    console.log(
      `${tag} dry run — would write ${mapped.length} run-detector + ${hwsRows.length} hws-model derivation(s), ` +
        `${periods.length} interval(s), re-keying ${strays.length} pre-existing row(s).`,
    );
    return;
  }

  // Drop the stray-id rows first (with their intervals — the FK may not be CASCADE yet, so be
  // explicit) so the deterministic insert can't collide on (area_id, role).
  for (const s of strays) {
    await db.transaction(async (tx) => {
      await tx
        .delete(derivedIntervals)
        .where(eq(derivedIntervals.derivationId, s.id));
      await tx.delete(derivations).where(eq(derivations.id, s.id));
    });
    console.log(`  ✓ removed stray-id ${s.id}`);
  }

  // Upsert derivations by deterministic PK, then rebuild each one's intervals atomically.
  for (const { derivation, systemId, role } of mapped) {
    await db
      .insert(derivations)
      .values(derivation)
      .onConflictDoUpdate({
        target: derivations.id,
        set: {
          areaId: derivation.areaId,
          kind: derivation.kind,
          role: derivation.role,
          name: derivation.name,
          enabled: derivation.enabled,
          output: derivation.output,
          outputPointId: derivation.outputPointId,
          params: derivation.params,
          sourcePoints: derivation.sourcePoints,
          detectorVersion: derivation.detectorVersion,
          updatedAt: derivation.updatedAt,
        },
      });

    const rows = (byKey.get(`${systemId}:${role}`) ?? []).map((r) =>
      mapRunPeriodToInterval(r, derivation.id),
    );
    await db.transaction(async (tx) => {
      await tx
        .delete(derivedIntervals)
        .where(eq(derivedIntervals.derivationId, derivation.id));
      if (rows.length > 0) await tx.insert(derivedIntervals).values(rows);
    });
    console.log(`  ✓ ${systemId}/${role}: ${rows.length} interval(s)`);
  }

  for (const h of hwsRows) {
    await db
      .insert(derivations)
      .values(h)
      .onConflictDoUpdate({
        target: derivations.id,
        set: {
          name: h.name,
          enabled: h.enabled,
          outputPointId: h.outputPointId,
          params: h.params,
          sourcePoints: h.sourcePoints,
        },
      });
    console.log(`  ✓ hws ${h.id}`);
  }

  console.log(
    `${tag} done: ${mapped.length} run-detector + ${hwsRows.length} hws-model derivation(s), ${periods.length} interval(s).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
