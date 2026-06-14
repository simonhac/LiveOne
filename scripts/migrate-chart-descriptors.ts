#!/usr/bin/env tsx
/**
 * One-off data migration: rewrite persisted `dashboards.descriptor` JSONB rows from the legacy chart
 * card types to the `chart` card — the WRITE side of PR #83's site-charts/energy-chart → chart rename.
 * The READ side (lib/dashboard/descriptor.ts `migrateLegacyChartCards`, run on every read) keeps old
 * rows working until this has run everywhere; this makes the STORED shape match.
 *
 * Transform (the exact effect of `migrateLegacyChartCards`):
 *   { type: "site-charts" }  -> { type: "chart", id: "chart:load", ... } + { id: "chart:generation", ... }
 *   { type: "energy-chart" } -> { type: "chart", id: "chart:lines", ... }   (each carries `hidden`)
 * Order and all other cards are preserved verbatim (NOT normalizeDescriptor — no per-system reconcile).
 *
 * Idempotent: only rows where `hasLegacyChartCards` is true are written, so already-current rows are
 * left byte-unchanged and a re-run reports 0. `updatedAt` is intentionally left untouched. Safe to
 * re-run; a partial/interrupted run self-heals on the next run.
 *
 * SAFETY: defaults to a DRY RUN (prints, writes nothing). Pass --apply to write. The startup banner
 * prints the resolved connection identity and TARGET (liveone-dev vs PROD sydney), derived from the
 * SAME PoolConfig the pool connects through — EYEBALL IT before --apply. Under --apply the run aborts
 * if it cannot positively classify the target (PLANETSCALE_PROD_BRANCH_ID unset), so a blind write is
 * impossible. Run only AFTER #83's read-shim is live on prod.
 *
 * Usage (loads .env.local via dotenv below; --env-file is the explicit equivalent):
 *   # DEV (liveone-dev):
 *   npx tsx --env-file=.env.local scripts/migrate-chart-descriptors.ts            # dry run
 *   npx tsx --env-file=.env.local scripts/migrate-chart-descriptors.ts --apply
 *
 *   # PROD (sydney) — mint a short-TTL role, pass its URL + the override INLINE. Run PROD FIRST (the
 *   # prod->dev sync would otherwise re-import legacy rows over a migrated dev). UPDATE-only → the temp
 *   # role deletes cleanly (no DDL):
 *   #   pscale role create liveone sydney migrate-chart --inherited-roles postgres --ttl 1h --format json
 *   PLANETSCALE_DATABASE_URL='<minted url>' ALLOW_PROD_DB_IN_DEV=true npx tsx scripts/migrate-chart-descriptors.ts
 *   PLANETSCALE_DATABASE_URL='<minted url>' ALLOW_PROD_DB_IN_DEV=true npx tsx scripts/migrate-chart-descriptors.ts --apply
 *   #   pscale role delete liveone sydney <role-id> --force
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import {
  connectionIdentity,
  getPoolConfig,
  requirePlanetscaleDb,
} from "../lib/db/planetscale";
import { dashboards } from "../lib/db/planetscale/schema";
import {
  migrateLegacyChartDescriptorRow,
  type DashboardDescriptor,
  type ModuleCardInstance,
} from "../lib/dashboard/descriptor";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";

/**
 * The connection identity (`user@host`) of the SAME PoolConfig the pool connects through, classified
 * against the prod token — reusing the lib helpers so the banner can never drift from the guard. The
 * hostname alone CANNOT distinguish dev from prod (every PlanetScale branch shares one regional
 * gateway host); only the username carries the branch id. `isProd` is null when it can't be
 * positively classified — the caller refuses to write in that case.
 */
function resolveTarget(): { identity: string; isProd: boolean | null } {
  const config = getPoolConfig();
  const identity = (config && connectionIdentity(config)) || "(unknown)";
  const token = process.env.PLANETSCALE_PROD_BRANCH_ID;
  const isProd =
    config && token
      ? identity.toLowerCase().includes(token.toLowerCase())
      : null;
  return { identity, isProd };
}

/** Card types, for the dry-run before→after line. */
const typesOf = (d: Partial<DashboardDescriptor>): string =>
  Array.isArray(d.cards)
    ? `[${d.cards.map((c) => (c as ModuleCardInstance)?.type ?? "?").join(", ")}]`
    : "(no cards)";

async function main() {
  const { identity, isProd } = resolveTarget();
  const target =
    isProd === null
      ? "UNKNOWN (PLANETSCALE_PROD_BRANCH_ID unset)"
      : isProd
        ? "PROD sydney"
        : "liveone-dev";
  console.log(`${tag} migrate-chart-descriptors`);
  console.log(`${tag} connection: ${identity}`);
  console.log(`${tag} TARGET = ${target}`);
  if (isProd) {
    console.log(
      `${tag} ⚠️  PRODUCTION database — the prod-in-dev guard is disarmed via ALLOW_PROD_DB_IN_DEV.`,
    );
  }
  if (APPLY && isProd === null) {
    throw new Error(
      "Refusing to --apply: cannot classify the target (PLANETSCALE_PROD_BRANCH_ID unset or no DB config).",
    );
  }

  const db = requirePlanetscaleDb();
  const rows = await db
    .select({ id: dashboards.id, descriptor: dashboards.descriptor })
    .from(dashboards);

  let candidates = 0;
  let rewritten = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of rows) {
    try {
      const descriptor = row.descriptor as Partial<DashboardDescriptor>;
      const next = migrateLegacyChartDescriptorRow(descriptor);
      if (!next) {
        skipped++;
        continue;
      }
      candidates++;

      console.log(
        `${tag}   #${row.id}: ${typesOf(descriptor)} -> ${typesOf(next)}`,
      );

      if (APPLY) {
        // descriptor only; updatedAt deliberately left as-is (shape fix, not a user edit).
        await db
          .update(dashboards)
          .set({ descriptor: next as DashboardDescriptor })
          .where(eq(dashboards.id, row.id));
      }
      rewritten++;
    } catch (err) {
      errored++;
      console.error(
        `${tag}   #${row.id}: ERROR — ${err instanceof Error ? err.message : String(err)} (skipping)`,
      );
    }
  }

  // `candidates` = legacy rows found; `rewritten` = those whose write succeeded (under --apply) or
  // would be written (dry run). They diverge only when a write throws mid-row (that row → errored).
  console.log(
    `${tag} done. total=${rows.length} candidates=${candidates} ` +
      `${APPLY ? "rewritten" : "would-rewrite"}=${rewritten} skipped(already-current)=${skipped} errored=${errored}`,
  );
  if (rewritten + skipped + errored !== rows.length) {
    throw new Error(
      `tally mismatch: ${rewritten}+${skipped}+${errored} != ${rows.length}`,
    );
  }
  if (!APPLY && candidates > 0) {
    console.log(
      `${tag} Re-run with --apply to write these ${candidates} row(s).`,
    );
  }
  process.exit(errored > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("✗ migrate-chart-descriptors failed:", err);
  process.exit(1);
});
