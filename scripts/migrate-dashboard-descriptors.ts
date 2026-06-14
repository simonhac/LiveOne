#!/usr/bin/env tsx
/**
 * One-off data migration: rewrite persisted `dashboards.descriptor` JSONB rows from the legacy card
 * shape to the current one — the WRITE side of PR #77's expand→migrate→contract rename. The READ
 * side (lib/dashboard/descriptor.ts `migrateLegacyDescriptor`, run on every read) keeps old rows
 * working until this has run everywhere; this makes the STORED shape match.
 *
 * Transform = a faithful RENAME only (the exact effect of `migrateLegacyDescriptor`):
 *   { type: "amber" }        -> { type: "amber-now" } + { type: "amber-timeline" } (inherit hidden)
 *   { type: "power-cards", powerCards } -> { type: "tiles", tiles }
 * It is NOT `normalizeDescriptor` — that is lossy for a bulk rewrite (discards on layout mismatch,
 * drops cards absent from the per-system default). The read path still normalizes on display.
 *
 * Idempotent: only rows where `hasLegacyCards` is true are written, so already-current rows are left
 * byte-unchanged and a re-run reports 0. `updatedAt` is intentionally left untouched (this is a
 * system shape-fix, not a user edit). Safe to re-run; a partial/interrupted run self-heals on the
 * next run (the guard skips already-migrated rows).
 *
 * SAFETY: defaults to a DRY RUN (prints, writes nothing). Pass --apply to write. The startup banner
 * prints the resolved connection identity and TARGET (liveone-dev vs PROD sydney), derived from the
 * SAME PoolConfig the pool connects through — EYEBALL IT before --apply, especially on prod where
 * ALLOW_PROD_DB_IN_DEV disarms the fail-closed guard. Under --apply the run aborts if it cannot
 * positively classify the target (PLANETSCALE_PROD_BRANCH_ID unset), so a blind write is impossible.
 *
 * Usage (this script loads .env.local via dotenv below; --env-file is the explicit equivalent):
 *   # DEV (liveone-dev):
 *   npx tsx --env-file=.env.local scripts/migrate-dashboard-descriptors.ts            # dry run
 *   npx tsx --env-file=.env.local scripts/migrate-dashboard-descriptors.ts --apply
 *
 *   # PROD (sydney) — mint a short-TTL role, pass its URL + the override INLINE (not exported, so it
 *   # can't leak into a later dev run). Run PROD FIRST (the prod->dev sync would otherwise re-import
 *   # legacy rows over a migrated dev). UPDATE-only → the temp role deletes cleanly (no DDL):
 *   #   pscale role create liveone sydney migrate-descriptors --inherited-roles postgres --ttl 1h --format json
 *   PLANETSCALE_DATABASE_URL='<minted url>' ALLOW_PROD_DB_IN_DEV=true npx tsx scripts/migrate-dashboard-descriptors.ts
 *   PLANETSCALE_DATABASE_URL='<minted url>' ALLOW_PROD_DB_IN_DEV=true npx tsx scripts/migrate-dashboard-descriptors.ts --apply
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
  migrateLegacyDescriptorRow,
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
 * positively classified (no token, or no config) — the caller refuses to write in that case.
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
  console.log(`${tag} migrate-dashboard-descriptors`);
  console.log(`${tag} connection: ${identity}`);
  console.log(`${tag} TARGET = ${target}`);
  if (isProd) {
    console.log(
      `${tag} ⚠️  PRODUCTION database — the prod-in-dev guard is disarmed via ALLOW_PROD_DB_IN_DEV.`,
    );
  }
  if (APPLY && isProd === null) {
    // Never write blind: if we can't positively say dev-or-prod, a mislabelled banner could
    // authorize a prod write. Refuse. (Set PLANETSCALE_PROD_BRANCH_ID so classification works.)
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
      const next = migrateLegacyDescriptorRow(descriptor);
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
  console.error("✗ migrate-dashboard-descriptors failed:", err);
  process.exit(1);
});
