#!/usr/bin/env tsx
/**
 * OFFLINE replay of the battery-provenance engine over REAL history — the HARNESS DRIVER.
 *
 * It is a thin wrapper over the SHARED engine: `loadProvenanceInputs()` (I/O) + `computeBatteryProvenance()`
 * (pure) — the SAME two functions the prod driver calls. This driver differs only at the edges: it points
 * at a historical window (dev mirror) and PRINTS an inspector panel instead of writing rows. Because load
 * and compute are split, it can load a window once and sweep configs (`--eta`, `--floor`, `--solar`,
 * `--no-soc`) cheaply.
 *
 * STRICTLY READ-ONLY + DRY-RUN. The DB target is whatever `.env.local` points at; prod (sydney) has NO
 * stored connection string, so a stored URL is `liveone-dev`, the prod mirror. Identity is printed up front.
 *
 * Usage:
 *   npx tsx scripts/replay-battery-provenance.ts --discover
 *   npx tsx scripts/replay-battery-provenance.ts --system=<handle> --days=3
 *   npx tsx scripts/replay-battery-provenance.ts --system=<handle> --start=2025-10-25 --end=2025-11-05 \
 *        --floor=10 --solar=zero --eta=0.9 --no-soc
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// Read-only replay: alias the stored (liveone-dev) migrations URL to the runtime var so `planetscaleDb`
// connects. Never in app code — this is workstation-only. (In practice the shell also sets it externally
// so it wins the ESM import race; this is a fallback.)
if (
  !process.env.PLANETSCALE_DATABASE_URL &&
  process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS
) {
  process.env.PLANETSCALE_DATABASE_URL =
    process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS;
}

import { and, eq, or, sql } from "drizzle-orm";
import { planetscaleDb } from "../lib/db/planetscale";
import { areas, pointInfo } from "../lib/db/planetscale/schema";
import { loadProvenanceInputs } from "../lib/battery-provenance/load";
import { computeBatteryProvenance } from "../lib/battery-provenance/compute";
import type {
  ProvenanceConfig,
  ProvenanceInputs,
  ProvenanceResult,
} from "../lib/battery-provenance/types";

// ---- arg parsing --------------------------------------------------------
const argOf = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DISCOVER = process.argv.includes("--discover");
const SYSTEM = argOf("system") ? Number(argOf("system")) : null;
const DAYS = argOf("days") ? Number(argOf("days")) : 3;
const START = argOf("start");
const END = argOf("end");
const FLOOR = argOf("floor");
const ETA = argOf("eta");
const SOLAR_VALUATION = (argOf("solar") ?? "zero") as "zero" | "opportunity";
const NO_SOC = process.argv.includes("--no-soc");

function db() {
  if (!planetscaleDb) {
    throw new Error(
      "No Postgres connection (set PLANETSCALE_DATABASE_URL or PLANETSCALE_DATABASE_URL_MIGRATIONS in .env.local).",
    );
  }
  return planetscaleDb;
}

async function runDiscover() {
  const rows = await db()
    .select({
      systemId: pointInfo.systemId,
      stem: pointInfo.logicalPathStem,
      metric: pointInfo.metricType,
    })
    .from(pointInfo)
    .where(
      or(
        and(
          eq(pointInfo.logicalPathStem, "bidi.battery"),
          eq(pointInfo.metricType, "soc"),
        ),
        eq(pointInfo.logicalPathStem, "load.ev"),
        and(
          eq(pointInfo.logicalPathStem, "bidi.grid.import"),
          eq(pointInfo.metricType, "rate"),
        ),
      ),
    );
  const bySystem = new Map<number, Set<string>>();
  for (const r of rows) {
    const key = `${r.stem}/${r.metric}`;
    if (!bySystem.has(r.systemId)) bySystem.set(r.systemId, new Set());
    bySystem.get(r.systemId)!.add(key);
  }
  const areaRows = await db()
    .select({
      id: areas.id,
      handle: areas.legacySystemId,
      name: areas.displayName,
    })
    .from(areas);
  console.log(
    "\nCandidate systems (have battery SoC / EV load / Amber price):",
  );
  for (const [systemId, feats] of bySystem)
    console.log(`  system ${systemId}: ${[...feats].sort().join(", ")}`);
  console.log("\nAreas (handle = --system):");
  for (const a of areaRows)
    console.log(`  handle ${a.handle}  area ${a.id}  "${a.name ?? ""}"`);
}

const fmtT = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function report(
  inputs: ProvenanceInputs,
  result: ProvenanceResult,
  config: ProvenanceConfig,
) {
  const { timeline, soc, coverage, region } = inputs;
  const {
    steps,
    finalState: fs,
    accounting: attr,
    etaUsed,
    reserveUsed,
  } = result;
  const solar = config.solarValuation ?? "zero";
  const etaLearned =
    config.efficiency === undefined || config.efficiency === "measured";

  console.log(
    `\n=== Battery-provenance replay: handle ${inputs.handle}, area ${inputs.areaId} ===`,
  );
  console.log(
    `window ${fmtT(timeline[0])} .. ${fmtT(timeline[timeline.length - 1])} UTC  (${timeline.length} intervals)`,
  );
  console.log(
    `reserve=${reserveUsed.toFixed(0)}%  η=${(100 * etaUsed).toFixed(1)}%${etaLearned ? "(learned)" : "(set)"}  ` +
      `solar=${solar}  region=${region ?? "none"}`,
  );
  console.log(
    `input coverage:  SoC ${(100 * coverage.soc).toFixed(0)}%   ` +
      `emissions ${(100 * coverage.emissions).toFixed(0)}%   price ${(100 * coverage.price).toFixed(0)}%\n`,
  );

  console.log("Battery blend (sampled every ~2h):");
  console.log(
    "  time (UTC)        SoC%   E(kWh)   g/kWh   %renew   c/kWh   est%",
  );
  for (let i = 0; i < steps.length; i += 24) {
    const s = steps[i];
    console.log(
      "  " +
        [
          fmtT(timeline[i]).padEnd(17),
          (soc[i] ?? NaN).toFixed(0).padStart(4),
          s.storedKwh.toFixed(2).padStart(7),
          (s.batteryEmissionsIntensity ?? NaN).toFixed(0).padStart(6),
          s.batteryRenewableFraction == null
            ? "   -- "
            : (s.batteryRenewableFraction * 100).toFixed(0).padStart(6),
          (s.batteryPrice ?? NaN).toFixed(1).padStart(6),
          (s.estimatedFraction * 100).toFixed(0).padStart(5),
        ].join(" "),
    );
  }

  const loadIdx = (p: string) => attr.loads.indexOf(p);
  const sumCol = (m: number[][], l: number) =>
    m.reduce((acc, row) => acc + row[l], 0);

  console.log("\nPer-load attribution over window:");
  console.log(
    "  load                  kWh     $cost   avg c/kWh   %renew   avg g/kWh   %est",
  );
  for (let l = 0; l < attr.loads.length; l++) {
    const kwh = sumCol(attr.energyKwh, l);
    if (kwh < 0.05) continue;
    const g = sumCol(attr.emissionsG, l);
    const gKwh = sumCol(attr.emissionsKnownKwh, l);
    const rkwh = sumCol(attr.renewableKwh, l);
    const rKwh = sumCol(attr.renewableKnownKwh, l);
    const c = sumCol(attr.costC, l);
    const cKwh = sumCol(attr.priceKnownKwh, l);
    const estKwh = sumCol(attr.estimatedKwh, l);
    console.log(
      "  " +
        [
          attr.loads[l].padEnd(20),
          kwh.toFixed(1).padStart(7),
          (c / 100).toFixed(2).padStart(8),
          cKwh > 0 ? (c / cKwh).toFixed(1).padStart(9) : "     -- ",
          rKwh > 0 ? ((100 * rkwh) / rKwh).toFixed(0).padStart(7) : "    -- ",
          gKwh > 0 ? (g / gKwh).toFixed(0).padStart(10) : "       -- ",
          ((100 * estKwh) / Math.max(kwh, 1e-9)).toFixed(0).padStart(5),
        ].join(" "),
    );
  }

  const ev = loadIdx("load.ev");
  if (ev >= 0) {
    const kwh = sumCol(attr.energyKwh, ev);
    const g = sumCol(attr.emissionsG, ev);
    const gKwh = sumCol(attr.emissionsKnownKwh, ev);
    const rkwh = sumCol(attr.renewableKwh, ev);
    const rKwh = sumCol(attr.renewableKnownKwh, ev);
    const c = sumCol(attr.costC, ev);
    const cKwh = sumCol(attr.priceKnownKwh, ev);
    const estKwh = sumCol(attr.estimatedKwh, ev);
    console.log(`\n=== EV charging over window (${kwh.toFixed(1)} kWh) ===`);
    console.log(
      `  cost:            $${(c / 100).toFixed(2)}  (avg ${cKwh > 0 ? (c / cKwh).toFixed(1) : "--"} c/kWh)`,
    );
    console.log(
      `  renewable:       ${rKwh > 0 ? ((100 * rkwh) / rKwh).toFixed(0) : "--"}%`,
    );
    console.log(
      `  emissions:       ${gKwh > 0 ? (g / gKwh).toFixed(0) : "--"} g/kWh  (${(g / 1000).toFixed(2)} kg total)`,
    );
    console.log(
      `  estimated:       ${((100 * estKwh) / Math.max(kwh, 1e-9)).toFixed(0)}% of energy`,
    );
    console.log("  by source:");
    for (let s = 0; s < attr.sources.length; s++) {
      const e = attr.energyKwh[s][ev];
      if (e > 0.05)
        console.log(`    ${attr.sources[s].padEnd(20)} ${e.toFixed(1)} kWh`);
    }
  } else {
    console.log(
      "\n(No load.ev node in this Area — EV not separately metered here.)",
    );
  }

  // ---- model internals / inspector panel ----
  const socStart = soc.find((v) => v !== null) ?? null;
  const socEnd = [...soc].reverse().find((v) => v !== null) ?? null;
  console.log("\n=== Battery model internals ===");
  console.log(
    `  round-trip efficiency:  Σout ${result.dischargeKwh.toFixed(0)} / Σin ${result.chargeKwh.toFixed(0)} = ` +
      `${((100 * result.dischargeKwh) / Math.max(result.chargeKwh, 1e-9)).toFixed(1)}%` +
      (socStart != null && socEnd != null
        ? `  (SoC ${socStart.toFixed(0)}→${socEnd.toFixed(0)}%, Δ${(socEnd - socStart).toFixed(0)}pp bias)`
        : "  (no SoC — trust over a long window)"),
  );
  console.log(
    `  inferred usable capacity: ${fs.maxObservedCapacityKwh.toFixed(1)} kWh (max E between bottom-outs)`,
  );
  console.log(
    `  resets: ${fs.resetsEmpty} empty + ${fs.resetsSocFloor} soc-floor + ${fs.resetsBackstop} backstop` +
      ` = ${fs.resetsEmpty + fs.resetsSocFloor + fs.resetsBackstop} total`,
  );
  console.log(
    `  round-trip LOSS (priced into delivered): ${fs.roundtripLossKwh.toFixed(1)} kWh, ` +
      `$${(fs.roundtripLossC / 100).toFixed(2)}, ${(fs.roundtripLossG / 1000).toFixed(1)} kg CO2`,
  );
  console.log(
    `  UNATTRIBUTED loss (drift/forced-reset residual): ${fs.unattribLossKwh.toFixed(1)} kWh, ` +
      `$${(fs.unattribLossC / 100).toFixed(2)}, ${(fs.unattribLossG / 1000).toFixed(1)} kg CO2`,
  );

  // Conservation self-audit: every gram charged is vended, discarded as unattributed, or still stored.
  let foldVendedG = 0;
  for (const s of steps)
    foldVendedG += s.dischargedKwh * (s.batteryEmissionsIntensity ?? 0);
  const auditG =
    result.chargedG - (foldVendedG + fs.unattribLossG + fs.carbonG);
  const auditPct = (100 * Math.abs(auditG)) / Math.max(result.chargedG, 1e-9);
  console.log(
    `  conservation (carbon): charged ${(result.chargedG / 1000).toFixed(1)} = vended ${(foldVendedG / 1000).toFixed(1)} ` +
      `+ unattrib ${(fs.unattribLossG / 1000).toFixed(1)} + stored ${(fs.carbonG / 1000).toFixed(1)} kg ` +
      `→ residual ${auditPct.toFixed(2)}% ${auditPct < 0.5 ? "✓" : "⚠"}`,
  );

  const totalEnergy = attr.energyKwh.flat().reduce((a, b) => a + b, 0);
  const totalEst = attr.estimatedKwh.flat().reduce((a, b) => a + b, 0);
  console.log(
    `  coverage: total flow ${totalEnergy.toFixed(0)} kWh, estimated ${((100 * totalEst) / Math.max(totalEnergy, 1e-9)).toFixed(0)}%`,
  );
}

async function runReplay(handle: number) {
  const nowMs = Date.now();
  const startMs = START
    ? Date.parse(`${START}T00:00:00Z`)
    : nowMs - DAYS * 24 * 3600 * 1000;
  const endMs = END ? Date.parse(`${END}T23:59:59Z`) : nowMs;

  const inputs = await loadProvenanceInputs(
    handle,
    { startMs, endMs },
    { noSoc: NO_SOC },
  );
  if (!inputs) {
    console.log(
      "Nothing to replay (no Area / no complete source-load set / not enough 5m data).",
    );
    return;
  }

  const config: ProvenanceConfig = {
    reserveFloorPct: FLOOR ? Number(FLOOR) : undefined,
    efficiency: ETA ? Number(ETA) : "measured",
    solarValuation: SOLAR_VALUATION,
  };
  const result = computeBatteryProvenance(inputs, config);
  report(inputs, result, config);
}

async function main() {
  const idres: any = await db().execute(
    sql`select current_user as usr, current_database() as dbname`,
  );
  const id = idres.rows?.[0] ?? idres[0] ?? {};
  console.log(`[DB] connected as ${id.usr}@${id.dbname} (READ-ONLY replay)`);

  if (DISCOVER) return runDiscover();
  if (SYSTEM == null) {
    console.log("Pass --system=<handle> (or --discover to list candidates).");
    return;
  }
  await runReplay(SYSTEM);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
