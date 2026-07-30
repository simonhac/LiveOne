#!/usr/bin/env tsx
/**
 * One-off (#273 follow-up): move the Sigenergy site's two power points onto the `load` HIERARCHY.
 *
 *   load_w : `load`      → `load.rest-of-house`   (the vendor's loadPower EXCLUDES the AC charger,
 *                                                  i.e. it IS the complement — measured, not synthesised)
 *   ev_w   : `ev.charge` → `load.ev`              (this charger sits INSIDE the site load meter)
 *   binding: role `ev`   → role `load` @ priority 1
 *
 * `load_interval_wh` keeps the master `load` stem — it is the site TOTAL — and this script asserts
 * that rather than assuming it.
 *
 * ── Why a script and not four UPDATEs ────────────────────────────────────────────────────────────
 * Three things have to move together, and two of them are easy to forget:
 *
 *  1. `point_info.logical_path_stem` — the stem the flow pipeline actually reads.
 *  2. `points.logical_path` — the config-v4 mirror. Nothing re-syncs it: `mirrorPoint` is fed the row
 *     RETURNED by the `point_info` upsert, so it only ever re-copies whatever is already there. (Dev
 *     was left half-migrated exactly this way — `point_info` re-stemmed, mirror still on the old value.)
 *  3. The KV latest-values hash, whose FIELD NAME is `<stem>/<metric>` (kv-cache-manager.ts). Nothing
 *     reaps a renamed field: after the re-stem the poller starts writing `load.rest-of-house/power`
 *     and `load.ev/power`, and the old `load/power` / `ev.charge/power` fields sit there FROZEN at
 *     their last value, indistinguishable from live data to any card that reads them.
 *
 * Note the stems will never self-correct on their own: `ensurePointInfo`'s upsert deliberately omits
 * `logicalPathStem` from its `onConflictDoUpdate` set (point-manager.ts), so redeploying and polling
 * changes nothing.
 *
 * Idempotent: re-running after a successful apply reports "already applied" and exits 0. Safe to
 * re-run after a partial failure — each of the three legs is checked independently.
 *
 * Resolves the system by `vendor_type='sigenergy'` (requiring exactly one), so the same invocation is
 * correct on dev and prod without hardcoding an id.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────────────────────────
 *   # dev (dry run, then apply)
 *   npx tsx scripts/utils/restem-sigenergy-load-hierarchy.ts --env=dev
 *   npx tsx scripts/utils/restem-sigenergy-load-hierarchy.ts --env=dev --apply
 *
 *   # prod — mint a short-TTL role first (see CLAUDE.md); creates no objects, so no ownership trap
 *   pscale role create liveone sydney restem --inherited-roles postgres --ttl 1h --format json
 *   PLANETSCALE_DATABASE_URL="<that url>" npx tsx \
 *     scripts/utils/restem-sigenergy-load-hierarchy.ts --env=prod --apply
 *   pscale role delete liveone sydney <role-id> --force
 *
 * `--env` is REQUIRED and is not a hint: it picks the KV key prefix (`prod:` / `dev:` — one physical
 * store, namespaced), and it is cross-checked against the DB connection identity via
 * PLANETSCALE_PROD_BRANCH_ID. A prod prefix with a dev connection (or vice versa) aborts before any
 * write. Do NOT let it default.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const OLD_LOAD_STEM = "load";
const NEW_LOAD_STEM = "load.rest-of-house";
const OLD_EV_STEM = "ev.charge";
const NEW_EV_STEM = "load.ev";

/** The three points this touches, keyed by physical_path_tail. */
const RESTEM = [
  { tail: "load_w", from: OLD_LOAD_STEM, to: NEW_LOAD_STEM },
  { tail: "ev_w", from: OLD_EV_STEM, to: NEW_EV_STEM },
] as const;
/** Must NOT move — the site total. */
const MASTER = { tail: "load_interval_wh", stem: "load" };

function die(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

/** `user@host` for the configured connection — the same identity the DB env guard uses. */
function connectionIdentity(): string | undefined {
  const url = process.env.PLANETSCALE_DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url);
      return `${u.username}@${u.host}`;
    } catch {
      return url;
    }
  }
  if (process.env.DB_HOST)
    return `${process.env.DB_USER ?? ""}@${process.env.DB_HOST}`;
  return undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const envArg = process.argv
    .find((a) => a.startsWith("--env="))
    ?.slice("--env=".length);
  if (envArg !== "prod" && envArg !== "dev")
    die("--env=prod|dev is required (it selects the KV key prefix).");

  // Must be set BEFORE importing anything that resolves the environment: `planetscaleDb` is an
  // import-time IIFE, and kvKey() reads getEnvironment() to build the `prod:`/`dev:` prefix.
  if (envArg === "prod") process.env.VERCEL_ENV = "production";
  const kvPrefix = envArg === "prod" ? "prod" : "dev";

  // Cross-check the connection against the requested environment, BOTH directions. The built-in
  // guard is fail-open in production; here a mismatch is always fatal, because the whole point of
  // --env is to name which store gets written.
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID;
  if (!prodToken)
    die(
      "PLANETSCALE_PROD_BRANCH_ID is not set — refusing to run without the prod/dev discriminator.",
    );
  const identity = connectionIdentity();
  if (!identity) die("No database connection configured.");
  const onProdDb = identity.toLowerCase().includes(prodToken.toLowerCase());
  if (envArg === "prod" && !onProdDb)
    die(
      `--env=prod but the connection (${identity}) is not the prod database. Point PLANETSCALE_DATABASE_URL at the sydney branch.`,
    );
  if (envArg === "dev" && onProdDb)
    die(
      `--env=dev but the connection (${identity}) IS the prod database. Refusing.`,
    );
  console.log(`• target: ${envArg}  db=${identity}  kv-prefix=${kvPrefix}:`);
  console.log(
    `• mode:   ${apply ? "APPLY" : "dry run (pass --apply to write)"}`,
  );

  const { and, eq, inArray } = await import("drizzle-orm");
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  const { devices, pointInfo, points, areas, areaBindings } = await import(
    "@/lib/db/planetscale/schema"
  );
  if (!planetscaleDb) die("Postgres not configured.");
  const db = planetscaleDb;

  // ── Resolve the system ────────────────────────────────────────────────────────────────────────
  const sigen = await db
    .select({ id: devices.rid, displayName: devices.name })
    .from(devices)
    .where(eq(devices.vendor, "sigenergy"));
  if (sigen.length !== 1)
    die(
      `expected exactly one sigenergy system, found ${sigen.length} — resolve by hand.`,
    );
  const systemId = sigen[0].id;
  console.log(`• system ${systemId} "${sigen[0].displayName}" (sigenergy)`);

  // ── Read current state: point_info joined to its config-v4 mirror ─────────────────────────────
  const rows = await db
    .select({
      index: pointInfo.index,
      tail: pointInfo.physicalPathTail,
      metricType: pointInfo.metricType,
      piStem: pointInfo.logicalPathStem,
      pointUid: pointInfo.pointUid,
      mirrorPath: points.logicalPath,
      deviceId: points.deviceId,
    })
    .from(pointInfo)
    .leftJoin(points, eq(points.id, pointInfo.pointUid))
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        inArray(pointInfo.physicalPathTail, [
          ...RESTEM.map((r) => r.tail),
          MASTER.tail,
        ]),
      ),
    );

  const byTail = new Map(rows.map((r) => [r.tail, r]));

  // The site total must not have moved.
  const master = byTail.get(MASTER.tail);
  if (!master) die(`no ${MASTER.tail} point on system ${systemId}.`);
  if (master.piStem !== MASTER.stem)
    die(
      `${MASTER.tail} carries stem "${master.piStem}", expected "${MASTER.stem}" (it is the site TOTAL and must not be re-stemmed).`,
    );

  // ── Plan the point writes ─────────────────────────────────────────────────────────────────────
  const pointWrites: { index: number; tail: string; to: string }[] = [];
  const mirrorWrites: { index: number; tail: string; to: string }[] = [];
  for (const r of RESTEM) {
    const row = byTail.get(r.tail);
    if (!row) die(`no ${r.tail} point on system ${systemId}.`);
    if (row.metricType !== "power")
      die(`${r.tail} has metric_type "${row.metricType}", expected "power".`);

    if (row.piStem === r.from) pointWrites.push({ ...r, index: row.index });
    else if (row.piStem !== r.to)
      die(
        `${r.tail} carries an unexpected stem "${row.piStem}" (expected "${r.from}" or "${r.to}") — investigate before writing.`,
      );

    if (row.mirrorPath == null)
      die(`${r.tail} has no \`points\` mirror row — investigate.`);
    if (row.mirrorPath !== r.to) mirrorWrites.push({ ...r, index: row.index });
  }

  // Unique-index pre-flight. `pi_system_stem_metric_unique` on (system_id, stem, metric_type) and
  // `points_device_logical_metric_unique` on (device_id, logical_path, metric_type): the target stem
  // must not already be occupied by some OTHER point.
  const targets = RESTEM.map((r) => r.to);
  const piClash = await db
    .select({ index: pointInfo.index, stem: pointInfo.logicalPathStem })
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        eq(pointInfo.metricType, "power"),
        inArray(pointInfo.logicalPathStem, targets),
      ),
    );
  for (const c of piClash) {
    const owner = RESTEM.find((r) => r.to === c.stem)!;
    const expected = byTail.get(owner.tail)!.index;
    if (c.index !== expected)
      die(
        `point_info (${systemId}, "${c.stem}", power) is already held by point ${c.index}, not the expected ${expected}.`,
      );
  }
  const deviceIds = [
    ...new Set(rows.map((r) => r.deviceId).filter((d): d is string => !!d)),
  ];
  if (deviceIds.length > 0) {
    const mirrorClash = await db
      .select({ id: points.id, path: points.logicalPath })
      .from(points)
      .where(
        and(
          inArray(points.deviceId, deviceIds),
          eq(points.metricType, "power"),
          inArray(points.logicalPath, targets),
        ),
      );
    for (const c of mirrorClash) {
      const owner = RESTEM.find((r) => r.to === c.path)!;
      const expectedUid = byTail.get(owner.tail)!.pointUid;
      if (c.id !== expectedUid)
        die(
          `points mirror already has logical_path "${c.path}" (power) on a different row (${c.id}).`,
        );
    }
  }

  // ── Plan the binding write ────────────────────────────────────────────────────────────────────
  const [area] = await db
    .select({ id: areas.id, name: areas.name })
    .from(areas)
    .where(eq(areas.legacySystemId, systemId))
    .limit(1);
  if (!area) die(`no area with legacy_system_id=${systemId}.`);

  const bindings = await db
    .select({
      id: areaBindings.id,
      role: areaBindings.role,
      metricType: areaBindings.metricType,
      pointUid: areaBindings.pointUid,
      priority: areaBindings.priority,
    })
    .from(areaBindings)
    .where(
      and(
        eq(areaBindings.areaId, area.id),
        eq(areaBindings.metricType, "power"),
      ),
    );

  // Bindings address their point by uuid (`area_bindings.point_uid`, NOT NULL since 0047), and the
  // row this script already read carries it — so match on that rather than the legacy index.
  const evUid = byTail.get("ev_w")!.pointUid;
  const evIndex = byTail.get("ev_w")!.index;
  const evBindings = bindings.filter(
    (b) => b.role === "ev" && b.pointUid === evUid,
  );
  const loadAtOne = bindings.filter(
    (b) => b.role === "load" && b.priority === 1,
  );
  let bindingWrite: string | null = null;
  if (evBindings.length > 1)
    die(`${evBindings.length} ev/power bindings on the EV point — expected 1.`);
  if (evBindings.length === 1) {
    // `area_bindings_slot_priority_unique` is (area_id, role, metric_type, priority) — priority 1
    // must be free before the ev binding can land there.
    if (loadAtOne.length > 0)
      die(
        `load/power priority=1 is already taken by binding ${loadAtOne[0].id} (point ${loadAtOne[0].pointUid}).`,
      );
    bindingWrite = evBindings[0].id;
  } else if (!bindings.some((b) => b.role === "load" && b.pointUid === evUid)) {
    die(
      `no ev/power binding on point ${evIndex} and no load/power binding either — investigate.`,
    );
  }

  // ── Report ────────────────────────────────────────────────────────────────────────────────────
  console.log(`\n• area ${area.id} "${area.name}" (handle ${systemId})`);
  console.log("\nPlanned DB changes:");
  if (pointWrites.length === 0 && mirrorWrites.length === 0 && !bindingWrite)
    console.log("    (none — DB already migrated)");
  for (const w of pointWrites)
    console.log(`    point_info [${w.index}] ${w.tail}: ${w.from} → ${w.to}`);
  for (const w of mirrorWrites)
    console.log(
      `    points mirror [${w.index}] ${w.tail}: ${byTail.get(w.tail)!.mirrorPath} → ${w.to}`,
    );
  if (bindingWrite)
    console.log(
      `    area_bindings ${bindingWrite}: role ev → load, priority → 1`,
    );

  // ── KV: find the frozen fields ────────────────────────────────────────────────────────────────
  // The hash field is `<stem>/<metric>`, so a re-stem orphans the old field in EVERY hash it was
  // fanned out to (the source system's own, plus each subscriber handle's). `load/power` is a
  // perfectly valid field for OTHER systems, so match on the stored `pointReference` — which records
  // the ORIGIN point as `<systemId>.<index>` — rather than on the field name alone.
  const { kv } = await import("@/lib/kv");
  const staleFields = RESTEM.map((r) => `${r.from}/power`);
  const originRefs = new Set(
    RESTEM.map((r) => `${systemId}.${byTail.get(r.tail)!.index}`),
  );
  const kvKeys = (await kv.keys(`${kvPrefix}:latest:system:*`)) ?? [];
  const kvDeletions: { key: string; fields: string[] }[] = [];
  for (const key of kvKeys) {
    const hash = (await kv.hgetall(key)) as Record<string, any> | null;
    if (!hash) continue;
    const fields = staleFields.filter((f) => {
      const v = hash[f];
      return !!v && originRefs.has(v.pointReference);
    });
    if (fields.length > 0) kvDeletions.push({ key, fields });
  }

  console.log("\nPlanned KV field deletions (frozen after the re-stem):");
  if (kvDeletions.length === 0) console.log("    (none)");
  for (const d of kvDeletions)
    console.log(`    ${d.key} → hdel ${d.fields.join(", ")}`);

  if (
    pointWrites.length === 0 &&
    mirrorWrites.length === 0 &&
    !bindingWrite &&
    kvDeletions.length === 0
  ) {
    console.log("\n✓ already applied — nothing to do.");
    process.exit(0);
  }

  if (!apply) {
    console.log("\n(dry run) nothing written. Re-run with --apply.");
    process.exit(0);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────────────────────────
  await db.transaction(async (tx) => {
    for (const w of pointWrites) {
      await tx
        .update(pointInfo)
        .set({ logicalPathStem: w.to, updatedAt: new Date() })
        .where(
          and(eq(pointInfo.systemId, systemId), eq(pointInfo.index, w.index)),
        );
    }
    for (const w of mirrorWrites) {
      const uid = byTail.get(w.tail)!.pointUid;
      await tx
        .update(points)
        .set({ logicalPath: w.to, updatedAt: new Date() })
        .where(eq(points.id, uid));
    }
    if (bindingWrite) {
      await tx
        .update(areaBindings)
        .set({ role: "load", priority: 1 })
        .where(eq(areaBindings.id, bindingWrite));
    }
  });
  console.log("\n✓ DB updated (one transaction).");

  for (const d of kvDeletions) {
    await kv.hdel(d.key, ...d.fields);
    console.log(`✓ hdel ${d.key} ${d.fields.join(" ")}`);
  }

  // A raw SQL binding UPDATE bypasses refreshAreaServing(), which is what normally rebuilds this.
  const { buildSubscriptionRegistry } = await import("@/lib/kv-cache-manager");
  await buildSubscriptionRegistry();
  console.log("✓ subscription registry rebuilt.");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
