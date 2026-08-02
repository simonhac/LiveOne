/**
 * Re-stem a physical CIRCUIT — every register on it — rather than a single point.
 *
 * A vendor driver derives a coarse `logical_path` from its own load type (`load`, `source.solar`,
 * `bidi.*`) and applies it to BOTH registers of a circuit. Refining that into the load hierarchy —
 * the circuit named "EV" is `load.ev` — is an operator act, and doing it one point at a time is how
 * a circuit ends up half-stemmed. That failure is silent: the energy register drops out of
 * `LogicalSystem.energyPoints`, the flow matrix falls back to integrating power, and the Sankey and
 * any run priced off that circuit start metering it from different registers.
 *
 * So the unit of a re-stem is the circuit. `scripts/utils/check-circuit-stems.ts` finds the ones
 * that have drifted.
 *
 *   npx tsx scripts/utils/restem-circuit.ts --point=50 --stem=load.ev [--apply]
 *
 * Dry run unless `--apply`. Only `power` and `energy` registers are touched — they are what the flow
 * resolver reads; a circuit's rate/state points carry their own vocabulary.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const arg = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");

function circuitOf(physicalPath: string): string {
  const i = physicalPath.lastIndexOf("/");
  return i < 0 ? physicalPath : physicalPath.slice(0, i);
}

/** Evidence window for "does this counter ever go backwards" — see the guard below. */
const NEG_PROBE_DAYS = 30;

async function countNegativeDeltas(pointUid: string): Promise<number> {
  const { ReadingsDao } = await import("@/lib/readings");
  const { Point } = await import("@/lib/ids");
  const point = Point.encode(pointUid);
  const toMs = Date.now();
  const series = await ReadingsDao.read5m([point], {
    fromMs: toMs - NEG_PROBE_DAYS * 86_400_000,
    toMs,
  });
  let n = 0;
  for (const r of series.get(point) ?? []) if ((r.delta ?? 0) < 0) n++;
  return n;
}

async function main() {
  const pointRid = Number(arg("point"));
  const stem = arg("stem");
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  if (!Number.isFinite(pointRid) || !stem) {
    console.error(
      "usage: --point=<rid> --stem=<logical.path> [--apply] [--force]",
    );
    process.exit(2);
  }

  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const { sql } = await import("drizzle-orm");
  const { classifyEnergyStem } = await import("@/lib/roles/registry");
  const db = requirePlanetscaleDb();

  const seedRes = await db.execute(sql`
    SELECT p.device_id, p.physical_path, d.name AS device, d.rid AS device_rid
    FROM points p JOIN devices d ON d.id = p.device_id WHERE p.rid = ${pointRid}`);
  const seed = (
    (seedRes.rows ?? seedRes) as unknown as Record<string, unknown>[]
  )[0];
  if (!seed) {
    console.error(`no point with rid=${pointRid}`);
    process.exit(1);
  }
  const circuit = circuitOf(String(seed.physical_path));

  const memRes = await db.execute(sql`
    SELECT p.rid, p.id AS point_uid, p.name, p.metric_type, p.logical_path AS stem, p.physical_path
    FROM points p
    WHERE p.device_id = ${String(seed.device_id)} AND p.metric_type IN ('power','energy')
    ORDER BY p.rid`);
  const candidates = (
    (memRes.rows ?? memRes) as unknown as Record<string, unknown>[]
  )
    .map((r) => ({
      rid: Number(r.rid),
      pointUid: String(r.point_uid),
      name: String(r.name),
      metricType: String(r.metric_type),
      stem: r.stem === null ? null : String(r.stem),
      physicalPath: String(r.physical_path),
    }))
    .filter((m) => circuitOf(m.physicalPath) === circuit);
  // Read through the readings DAO — `scripts/check-readings-boundary.mjs` hard-gates raw hot-table
  // access, including from `scripts/`, and an ops script is precisely the caller that would otherwise
  // grow a second query path into `point_readings_agg_5m`.
  const members = [];
  for (const c of candidates)
    members.push({
      ...c,
      neg:
        c.metricType === "energy" ? await countNegativeDeltas(c.pointUid) : 0,
    });

  console.log(
    `\ndevice ${seed.device} (rid ${seed.device_rid})   circuit ${circuit}\n`,
  );
  for (const m of members)
    console.log(
      `  ${String(m.rid).padStart(4)} ${m.metricType.padEnd(6)} ${m.name.padEnd(22)} ${(m.stem ?? "(NULL)").padEnd(22)} → ${stem}`,
    );

  // 🛑 The one unsafe re-stem, and the reason this tool exists rather than an UPDATE by hand.
  // `classifyEnergyStem` maps a bare `bidi.*` to kind `net`, whose overlay splits a SIGNED net by
  // sign onto the channel's two halves. A cumulative one-way total never goes backwards, so every
  // delta is positive and the whole circuit's throughput would be booked to a single direction —
  // e.g. 174 kWh of "battery discharge" against zero charge. A bidirectional circuit needs a
  // charge/discharge PAIR of registers (`bidi.battery.charge` + `.discharge`), which this vendor
  // does not publish.
  const cls = classifyEnergyStem(stem);
  const energyMembers = members.filter((m) => m.metricType === "energy");
  const blocked: string[] = [];
  if (energyMembers.length > 0) {
    if (cls === null) {
      blocked.push(
        `'${stem}' is not an overlayable energy stem (classifyEnergyStem → null); the counter would be stemmed but never read.`,
      );
    } else if (cls.kind === "net") {
      for (const m of energyMembers)
        if (m.neg === 0)
          blocked.push(
            `rid ${m.rid} has never gone backwards (0 negative deltas) — it is a one-way total, and '${stem}' means a SIGNED net register.`,
          );
    }
  }
  if (blocked.length > 0) {
    console.log("\n🛑 refusing:");
    for (const b of blocked) console.log(`   - ${b}`);
    if (!force) {
      console.log(
        "\n   (--force overrides, but read the note in this script first.)\n",
      );
      process.exit(1);
    }
    console.log("\n   --force given; proceeding anyway.\n");
  }

  const changing = members.filter((m) => m.stem !== stem);
  if (!apply) {
    console.log(
      `\ndry run — ${changing.length} stem(s) would change, plus any missing Area bindings.` +
        ` Re-run with --apply.\n`,
    );
    return;
  }

  for (const m of changing)
    await db.execute(
      sql`UPDATE points SET logical_path = ${stem} WHERE rid = ${m.rid}`,
    );
  console.log(
    changing.length > 0
      ? `\n✓ updated ${changing.length} point row(s).`
      : "\n  (stems already correct)",
  );

  // 🛑 STEMMING ALONE IS NOT ENOUGH FOR A BINDINGS-BACKED AREA, and this is the second half of the
  // same silent failure. `resolveLogicalSystem` resolves an Area's points through `area_bindings`, so
  // an unbound register is invisible no matter how it is stemmed — it never reaches
  // `LogicalSystem.energyPoints` and the flow matrix goes on integrating power. Measured on Kinkora:
  // re-stemming the EV counter changed the Sankey by exactly nothing until it was also bound.
  const bindRes = await db.execute(sql`
    SELECT ab.area_id, ab.role, p.rid, p.id AS point_uid, p.metric_type
    FROM area_bindings ab JOIN points p ON p.id = ab.point_uid
    WHERE p.rid IN (${sql.join(
      members.map((m) => sql`${m.rid}`),
      sql`, `,
    )})`);
  const bound = (
    (bindRes.rows ?? bindRes) as unknown as Record<string, unknown>[]
  ).map((r) => ({
    areaId: String(r.area_id),
    role: String(r.role),
    rid: Number(r.rid),
  }));
  const areasByRole = new Map<string, string>(); // areaId -> role, from whichever register is bound
  for (const b of bound) areasByRole.set(b.areaId, b.role);

  let added = 0;
  for (const [areaId, role] of areasByRole) {
    for (const m of members) {
      if (bound.some((b) => b.areaId === areaId && b.rid === m.rid)) continue;
      const uidRes = await db.execute(
        sql`SELECT id FROM points WHERE rid = ${m.rid}`,
      );
      const uid = String(
        ((uidRes.rows ?? uidRes) as unknown as Record<string, unknown>[])[0].id,
      );
      // `area_bindings_slot_priority_unique` is (area_id, role, metric_type, priority); `ordinal` is
      // the fold's tie-break and must stay unique enough to be deterministic. Take the next free of
      // each rather than guessing a slot.
      const nextRes = await db.execute(sql`
        SELECT coalesce(max(ordinal), 0) + 1 AS ord,
               (SELECT coalesce(max(priority), 0) + 1 FROM area_bindings
                  WHERE area_id = ${areaId} AND role = ${role} AND metric_type = ${m.metricType}) AS pri
        FROM area_bindings WHERE area_id = ${areaId}`);
      const next = (
        (nextRes.rows ?? nextRes) as unknown as Record<string, unknown>[]
      )[0];
      await db.execute(sql`
        INSERT INTO area_bindings (area_id, role, metric_type, point_uid, ordinal, priority)
        VALUES (${areaId}, ${role}, ${m.metricType}, ${uid}, ${Number(next.ord)}, ${Number(next.pri)})
        ON CONFLICT DO NOTHING`);
      console.log(
        `✓ bound rid ${m.rid} (${m.metricType}) into area ${areaId} as role='${role}'`,
      );
      added++;
    }
  }
  if (added === 0) console.log("  (bindings already complete)");

  console.log(
    "\n  Follow-ups: the flow matrix now meters this circuit from its energy register, so\n" +
      "  `point_readings_flow_attr_1d` must be recomputed over the affected history, and any run\n" +
      "  detector on this circuit re-priced (scoped with `derivation=`). A long-running app process\n" +
      "  may hold a resolved logical system — redeploy or let it refresh.\n",
  );
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
