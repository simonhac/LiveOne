#!/usr/bin/env tsx
/**
 * Price GENERATOR run periods that predate per-run provenance — IN PLACE, without re-detecting.
 *
 * WHY THIS EXISTS AND `backfill-run-periods.ts` DOES NOT DO IT.
 * `derived_intervals.cost_c` / `emissions_g` / `renewable_kwh` arrived with migration 0042
 * (2026-07-28) and `estimated_kwh` with 0057; every row written before then carries NULL. Nothing
 * heals them: the minutely reconcile is a 6h trailing window, and `rehealStaleRuns` deliberately
 * skips generators (their constants cannot drift — lib/run-tracking/intensity.ts). The visible
 * symptom is the Generator tile's "This period" row printing "—" for cost over any window that
 * reaches back past the migration, because `pricedTotal` (lib/provenance-format.ts) withholds a
 * total below 99.5% price coverage rather than show one that is silently too low.
 *
 * 🛑 The obvious fix — `backfill-run-periods.ts --role=generator --start=<a year ago> --apply` —
 * DESTROYS the very rows it is meant to price. `recomputeRange` is delete-and-reinsert from the
 * detector's CURRENT signal point, and Daylesford's generator was re-pointed to the DeepSea
 * engine-speed point whose history starts 2026-07-11. Every earlier run would be deleted and
 * nothing re-detected in its place (the script's own doc comment warns about exactly this).
 *
 * WHY AN IN-PLACE UPDATE IS EXACT, NOT AN APPROXIMATION. For `role === 'generator'`
 * `resolveIntensitySeries` returns a `constantIntensity` — the same factor at every instant — so
 * `provenanceFromAllocation`'s Σ over counter slices collapses to arithmetic on the row's stored
 * `energy_kwh`, and this writes byte-identical values to what a recompute would. That collapse is
 * ONLY valid for the generator: a load-priced role (`ev`) has a time-varying blend, so the script
 * refuses any other role rather than silently flattening it.
 *
 * SAFETY: dry run by default (prints the resolved constants and the rows it would touch). Pass
 * --apply to write. Scoped to ONE detector by construction — `--derivation` is required. The
 * UPDATE is gated on `cost_c IS NULL`, so it is idempotent and can never overwrite a row a
 * recompute already priced.
 *
 * ⚠️ `--env-file=.env.local` is required on the tsx invocation as well as the dotenv call below:
 * `planetscaleDb` is an IIFE evaluated at import, and esbuild hoists imports above dotenv.config().
 *
 * 🛑 Durable data lives in PROD; dev's `derived_intervals` are recomputed locally and are not the
 * rows anyone is looking at. Point the connection at a short-TTL `sydney` role and release the
 * prod guard for that ONE command.
 *
 * ⚠️ KEEP `--env-file=.env.local` EVEN WHEN OVERRIDING THE URL. That flag is what puts
 * PLANETSCALE_PROD_BRANCH_ID into the environment BEFORE this module's imports evaluate, which is
 * what arms `assertDbEnvironmentMatches`. Swapping it for `--env-file=/dev/null` to "keep dev's
 * URL out of the way" leaves the token to the in-file dotenv.config() below — which esbuild hoists
 * the imports above — and the fail-closed prod guard then silently never runs. A shell-exported
 * PLANETSCALE_DATABASE_URL already wins over both env files, so there is nothing to keep out of
 * the way. (Verified both directions 2026-08-30.)
 *
 * Usage:
 *   # dev (dry run)
 *   npx tsx --env-file=.env.local scripts/utils/price-legacy-generator-runs.ts \
 *     --derivation=947afbcc-ffde-5151-8de0-eba49355c243
 *
 *   # prod: mint a role, dry-run, then --apply
 *   pscale role create liveone sydney gen-price --inherited-roles \
 *     pg_read_all_data,pg_write_all_data --ttl 1h --format json
 *   ALLOW_PROD_DB_IN_DEV=true PLANETSCALE_DATABASE_URL="<that database_url>" \
 *     npx tsx --env-file=.env.local scripts/utils/price-legacy-generator-runs.ts \
 *     --derivation=947afbcc-ffde-5151-8de0-eba49355c243 [--apply]
 *   pscale role delete liveone sydney <role-id> --force
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { requirePlanetscaleDb } from "../../lib/db/planetscale";
import { derivedIntervals } from "../../lib/db/planetscale/schema";
import { listEnabledRunDetectors } from "../../lib/derivations/resolve";
import { resolveIntensitySeries } from "../../lib/run-tracking/intensity";
import { roundToThree } from "../../lib/history/format-opennem";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";

/** `--flag=value` → value, or undefined when the flag is absent. */
function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  const derivationId = arg("derivation");
  if (!derivationId) {
    fail(
      "--derivation=<uuid> is required. This script is scoped to ONE detector by construction; " +
        "find the id with: select id, role, name from derivations where role = 'generator';",
    );
  }

  const db = requirePlanetscaleDb();
  const [det] = await listEnabledRunDetectors({ derivationId });
  if (!det) fail(`No enabled run detector with id ${derivationId}.`);
  if (det.role !== "generator") {
    fail(
      `Detector ${derivationId} has role '${det.role}', not 'generator'. Only the generator's ` +
        `intensity is constant over time; every other priced role must be re-priced by a real ` +
        `recompute (scripts/backfill-run-periods.ts), not by this flattening UPDATE.`,
    );
  }

  // The window is required by the signature and IGNORED by the generator leg (constants).
  const series = await resolveIntensitySeries(db, det, {
    startMs: 0,
    endMs: 0,
  });
  if (!series) {
    fail(
      `No generator intensity for handle ${det.legacyHandle}: the site's battery device has no ` +
        `config.batteryProvenance.generatorSource (or its emissionsIntensity is not finite). ` +
        `Configure it first — there is nothing to price with.`,
    );
  }
  const f = series.at(0);
  if (f.priceC == null) {
    fail(
      `generatorSource for handle ${det.legacyHandle} carries no pricePerKwh, so cost_c would ` +
        `stay NULL and the coverage gate would keep withholding the total. Configure the price.`,
    );
  }

  console.log(
    `${tag} detector ${det.id} (handle ${det.legacyHandle}, "${det.name}")\n` +
      `       constants: ${f.priceC} c/kWh, ${f.gPerKwh} gCO₂/kWh, ` +
      `renewable ${f.renewable}, estimatedFraction ${f.estimatedFraction}`,
  );

  const rows = await db
    .select({
      startTime: derivedIntervals.startTime,
      energyKwh: derivedIntervals.energyKwh,
    })
    .from(derivedIntervals)
    .where(
      and(
        eq(derivedIntervals.derivationId, det.id),
        isNull(derivedIntervals.costC),
        isNotNull(derivedIntervals.energyKwh),
      ),
    )
    .orderBy(asc(derivedIntervals.startTime));

  if (rows.length === 0) {
    console.log(
      "Nothing to price — every run with energy already carries a cost.",
    );
    return;
  }

  // Per-month, so the shape of the gap is visible before writing (and matches the SQL anyone
  // runs to verify afterwards).
  const byMonth = new Map<string, { runs: number; kwh: number }>();
  for (const r of rows) {
    const key = r.startTime.toISOString().slice(0, 7);
    const acc = byMonth.get(key) ?? { runs: 0, kwh: 0 };
    acc.runs += 1;
    acc.kwh += r.energyKwh ?? 0;
    byMonth.set(key, acc);
  }
  console.log(`\n  month     runs      kWh       cost`);
  for (const [month, acc] of [...byMonth].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(
      `  ${month}  ${String(acc.runs).padStart(4)}  ${acc.kwh.toFixed(1).padStart(8)}  ` +
        `$${((acc.kwh * f.priceC!) / 100).toFixed(2).padStart(8)}`,
    );
  }
  const totalKwh = rows.reduce((s, r) => s + (r.energyKwh ?? 0), 0);
  console.log(
    `  TOTAL     ${String(rows.length).padStart(4)}  ${totalKwh.toFixed(1).padStart(8)}  ` +
      `$${((totalKwh * f.priceC) / 100).toFixed(2).padStart(8)}\n`,
  );

  if (!APPLY) {
    console.log("Dry run — pass --apply to write.");
    return;
  }

  // Rounded in JS with the same helper the recompute uses, rather than in SQL, so the stored
  // values are identical to a recompute's down to the last 3dp tie.
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const kwh = r.energyKwh!;
      await tx
        .update(derivedIntervals)
        .set({
          costC: roundToThree(kwh * f.priceC!),
          emissionsG: roundToThree(f.gPerKwh == null ? null : kwh * f.gPerKwh),
          renewableKwh: roundToThree(
            f.renewable == null ? null : kwh * f.renewable,
          ),
          estimatedKwh: roundToThree(kwh * f.estimatedFraction),
        })
        .where(
          and(
            eq(derivedIntervals.derivationId, det.id),
            eq(derivedIntervals.startTime, r.startTime),
            // Re-assert the gate inside the write: nothing may overwrite a priced row.
            isNull(derivedIntervals.costC),
          ),
        );
      updated += 1;
    }
  });
  console.log(`${tag} done: ${updated} run(s) priced.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
