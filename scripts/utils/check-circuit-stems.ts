/**
 * Fleet check: does every register on one physical CIRCUIT carry the same logical stem, and is the
 * whole circuit bound into the Areas that use it?
 *
 * A vendor that meters a circuit twice — instantaneous power and a cumulative energy counter —
 * emits two `points` rows whose `physical_path` shares a prefix (`<circuitId>/energyNowW` and
 * `<circuitId>/totalEnergyWh` for Mondo). They describe ONE thing, so they must be treated as one.
 *
 * They are stored independently, though, and the driver can only derive a COARSE stem from the
 * vendor's own load type (`load`, `source.solar`, `bidi.*`). Refining a circuit into the load
 * hierarchy — the circuit named "EV" is `load.ev`, not `load` — is an operator act, and applying it
 * to one register silently desynchronises the other. Nothing errors: an energy register that lacks a
 * stem (or a binding) never reaches `LogicalSystem.energyPoints`, so the flow matrix quietly falls
 * back to integrating power. The Sankey and any run priced off that circuit then meter it from
 * DIFFERENT registers and disagree by however much those registers disagree — 0.16% for Kinkora's
 * EV, and invisible until someone measures it.
 *
 * Two failure modes, same silence:
 *   1. stems disagree across the circuit;
 *   2. stems agree but only SOME registers are bound into an Area.
 *
 *   npx tsx scripts/utils/check-circuit-stems.ts [--all]
 *
 * Exit 1 if anything is off. `--all` also lists healthy multi-register circuits.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

interface Row {
  device: string;
  deviceRid: number;
  rid: number;
  name: string;
  metricType: string;
  stem: string | null;
  physicalPath: string;
  negativeDeltas: number;
  boundAreas: number;
}

/** The circuit a register belongs to: its physical path up to the last `/`. No slash ⇒ its own. */
function circuitOf(physicalPath: string): string {
  const i = physicalPath.lastIndexOf("/");
  return i < 0 ? physicalPath : physicalPath.slice(0, i);
}

/** Evidence window for "does this counter ever go backwards". */
const NEG_PROBE_DAYS = 30;

/**
 * How many 5-minute deltas of this register are negative, over a bounded recent window.
 *
 * This is the empirical test for SIGNED-net vs ONE-WAY-total, which no stem or column type can
 * answer. Read through the readings DAO, not raw SQL — `scripts/check-readings-boundary.mjs` is a
 * hard gate on the hot tables and it is right to be: a one-off ops script is exactly the sort of
 * caller that quietly grows a second query path. Bounded to a recent window because the claim is
 * about the register's NATURE; a month of evidence settles it, a full-history scan would not settle
 * it any harder.
 */
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
  const showAll = process.argv.includes("--all");
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const { sql } = await import("drizzle-orm");
  const { classifyEnergyStem } = await import("@/lib/roles/registry");
  const db = requirePlanetscaleDb();

  const res = await db.execute(sql`
    SELECT d.name AS device, d.rid AS device_rid, p.rid, p.id AS point_uid, p.name, p.metric_type,
           p.logical_path AS stem, p.physical_path,
           (SELECT count(DISTINCT ab.area_id) FROM area_bindings ab
              WHERE ab.point_uid = p.id) AS bound_areas
    FROM points p JOIN devices d ON d.id = p.device_id
    WHERE p.metric_type IN ('power', 'energy')
    ORDER BY d.rid, p.physical_path`);
  const raw = ((res.rows ?? res) as unknown as Record<string, unknown>[]).map(
    (r) => ({
      device: String(r.device),
      deviceRid: Number(r.device_rid),
      rid: Number(r.rid),
      pointUid: String(r.point_uid),
      name: String(r.name),
      metricType: String(r.metric_type),
      stem: r.stem === null ? null : String(r.stem),
      physicalPath: String(r.physical_path),
      boundAreas: Number(r.bound_areas),
    }),
  );

  const rows: Row[] = [];
  for (const r of raw)
    rows.push({
      ...r,
      negativeDeltas:
        r.metricType === "energy" ? await countNegativeDeltas(r.pointUid) : 0,
    });

  const byCircuit = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.deviceRid}::${circuitOf(r.physicalPath)}`;
    const g = byCircuit.get(key);
    if (g) g.push(r);
    else byCircuit.set(key, [r]);
  }

  const problems: string[] = [];
  let multi = 0;
  for (const [key, group] of [...byCircuit].sort()) {
    if (group.length < 2) continue;
    multi++;
    const stems = new Set(group.map((g) => g.stem ?? "(NULL)"));
    const consistent = stems.size === 1;
    const label = `${group[0].device} - ${key.split("::")[1]}`;
    const detail = group
      .map(
        (g) =>
          `      ${String(g.rid).padStart(4)} ${g.metricType.padEnd(6)} ${g.name.padEnd(22)} ${(g.stem ?? "(NULL)").padEnd(22)} bound:${g.boundAreas}`,
      )
      .join("\n");

    if (!consistent) {
      problems.push(`  FAIL ${label}\n${detail}`);
      // The repair an operator will reach for, and the one case where it is NOT safe.
      const power = group.find((g) => g.metricType === "power");
      const energy = group.find((g) => g.metricType === "energy");
      if (power?.stem && energy && energy.stem === null) {
        const cls = classifyEnergyStem(power.stem);
        if (cls === null) {
          problems.push(
            `      -> power's stem '${power.stem}' is not an overlayable energy stem; leave the counter unstemmed.`,
          );
        } else if (cls.kind === "net" && energy.negativeDeltas === 0) {
          problems.push(
            `      -> DO NOT copy '${power.stem}' onto rid ${energy.rid}: a bare bidi.* stem means a SIGNED\n` +
              `         net register, and this counter has never gone backwards (${energy.negativeDeltas} negative deltas),\n` +
              `         i.e. it is a one-way total. The overlay would book ALL of it to one direction.`,
          );
        } else {
          problems.push(
            `      -> safe: npx tsx scripts/utils/restem-circuit.ts --point=${energy.rid} --stem=${power.stem} --apply`,
          );
        }
      }
    } else if (showAll) {
      console.log(`  ok   ${label}\n${detail}`);
    }

    // The SECOND failure mode. `resolveLogicalSystem` resolves a bindings-backed Area's points
    // through `area_bindings`, so a correctly-stemmed register nobody bound is still invisible.
    // Measured on Kinkora: re-stemming the EV counter changed the Sankey by exactly nothing until it
    // was bound too — which is why this check exists alongside the stem one rather than instead.
    const someBound = group.some((g) => g.boundAreas > 0);
    const someUnbound = group.some((g) => g.boundAreas === 0);
    if (consistent && someBound && someUnbound)
      problems.push(
        `  FAIL ${label} - stems agree but the circuit is only PARTLY BOUND\n${detail}\n` +
          `      -> the unbound register(s) cannot reach any Area's logical system:\n` +
          `         npx tsx scripts/utils/restem-circuit.ts --point=${group[0].rid} --stem=${group[0].stem ?? ""} --apply`,
      );
  }

  console.log(`\n${multi} multi-register circuit(s) checked.`);
  if (problems.length === 0) {
    console.log("PASS - circuit stems and bindings consistent.");
    return;
  }
  console.log("\nProblems:\n");
  console.log(problems.join("\n"));
  console.log("");
  process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
