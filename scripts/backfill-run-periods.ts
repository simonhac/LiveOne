#!/usr/bin/env tsx
/**
 * Create run detectors, and backfill their derived intervals over the full history (run-tracking).
 *
 * Two modes, because they are the two halves of one operation — a detector is useless until its
 * history exists, and the backfill has always failed with "create a run-detector derivation for the
 * area first", which is precisely the thing `--seed` now does:
 *
 *   --seed    create ONE `run-detector` derivation (idempotent; deterministic id)
 *   (default) recompute intervals for EVERY enabled detector over a date range
 *
 * Data goes back to ~2025-08-16, so the backfill is NOT something to run through the 60s serverless
 * cron. Run it from a workstation via tsx: it calls the same chunked, idempotent `recomputeRange`
 * the cron uses (14-day chunks, bounded read + delete-and-reinsert per chunk, per-derivation
 * advisory lock), but with no function-duration limit and a progress line per chunk. Safe to
 * re-run / resume.
 *
 * SAFETY: defaults to a DRY RUN (prints the plan). Pass --apply to write. The DB target is
 * whatever .env.local points at.
 *
 * ⚠️ `--env-file=.env.local` is required on the tsx invocation as well as the dotenv call below:
 * `planetscaleDb` is an IIFE evaluated at import, and esbuild hoists imports above dotenv.config().
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-run-periods.ts                    # dry run, full history
 *   npx tsx --env-file=.env.local scripts/backfill-run-periods.ts --start=2025-08-16 # dry run from a date
 *   npx tsx --env-file=.env.local scripts/backfill-run-periods.ts --apply            # write, full history
 *
 *   # Scoped to ONE detector — what a historical backfill almost always wants (see backfillFilter):
 *   npx tsx --env-file=.env.local scripts/backfill-run-periods.ts --handle=6 --role=ev --apply
 *   npx tsx --env-file=.env.local scripts/backfill-run-periods.ts --derivation=<uuid> --apply
 *
 *   # Seed the Kinkora EV charge detector (Mondo EV circuit; signal + energy on the same meter):
 *   npx tsx --env-file=.env.local scripts/backfill-run-periods.ts --seed \
 *     --handle=6 --role=ev --name="EV charging" \
 *     --signal=8f6ceaad-8122-5230-8f03-dbb7c3a818c2 \
 *     --energy=ef1d1ba7-6381-5d0e-80cf-a76e6a5954bb \
 *     --upper=100 --delay-off=300 --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  ensureRunDetectorForHandle,
  listEnabledRunDetectors,
  type RunDetectorFilter,
  type RunDetectorParams,
} from "../lib/derivations/resolve";
import { describeFilter, recomputeRange } from "../lib/run-tracking/recompute";
import { TRACKABLE_ROLE_IDS, type RoleId } from "../lib/roles/registry";

const APPLY = process.argv.includes("--apply");
const SEED = process.argv.includes("--seed");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";
const startArg = process.argv.find((a) => a.startsWith("--start="));
const DEFAULT_START = "2025-08-16"; // LIVEONE birthdate
const startStr = startArg ? startArg.split("=")[1] : DEFAULT_START;

/** `--flag=value` → value, or undefined when the flag is absent. */
function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function num(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

/**
 * Create one run detector from the command line.
 *
 * Only the threshold bounds and delays are settable: hysteresis and boundary mode are per-role code
 * defaults (lib/run-tracking/defaults.ts) and deliberately have no flag, so a site can't quietly
 * acquire a one-off detection personality that nothing else in the fleet shares.
 *
 * The delays ARE settable, and writing them explicitly is worth doing when seeding ahead of a
 * deploy: a row carrying its own delays behaves identically no matter which build the cron is on,
 * whereas one relying on a brand-new role default detects with GENERIC_DEFAULTS until the code
 * lands.
 */
async function seed() {
  const handle = num("handle");
  const role = arg("role") as RoleId | undefined;
  const signal = arg("signal");
  const energy = arg("energy") ?? null;
  const lower = num("lower");
  const upper = num("upper");

  if (handle === undefined || !role || !signal) {
    throw new Error(
      "--seed needs --handle=<int> --role=<id> --signal=<point uuid> " +
        "(and at least one of --lower/--upper). Optional: --energy, --name, --delay-on, --delay-off.",
    );
  }
  if (!(TRACKABLE_ROLE_IDS as readonly string[]).includes(role)) {
    throw new Error(
      `--role=${role} is not trackable. Trackable roles: ${TRACKABLE_ROLE_IDS.join(", ")}`,
    );
  }

  // Sparse by convention — only keys given on the command line are persisted, so everything else
  // keeps inheriting the role defaults as they evolve.
  const params: RunDetectorParams = { signalKind: "power-threshold" };
  if (lower !== undefined) params.lowerW = lower;
  if (upper !== undefined) params.upperW = upper;
  const delayOn = num("delay-on");
  const delayOff = num("delay-off");
  if (delayOn !== undefined) params.delayOnSeconds = delayOn;
  if (delayOff !== undefined) params.delayOffSeconds = delayOff;

  const result = await ensureRunDetectorForHandle({
    handle,
    role,
    name: arg("name") ?? `${role} runs`,
    signalPointUid: signal,
    energyPointUid: energy,
    params,
    apply: APPLY,
  });

  console.log(
    `${tag} seed handle=${handle} role=${role} → ${result.status}` +
      (result.derivationId ? ` (${result.derivationId})` : "") +
      (result.areaId ? ` on area ${result.areaId}` : ""),
  );
  console.log(`      params: ${JSON.stringify(params)}`);
  console.log(`      source_points: ${JSON.stringify({ signal, energy })}`);

  if (result.status === "created" && !APPLY) {
    console.log(
      "Dry run — pass --apply to write, then re-run without --seed to backfill its history.",
    );
  } else if (result.status === "created") {
    console.log(
      "Created. Re-run without --seed (with --apply) to backfill its history.",
    );
  } else if (result.status !== "exists") {
    // Every other status is a refusal with a specific cause — surface it as a failure so a
    // scripted seed can't report success while having written nothing.
    process.exitCode = 1;
  }
}

/**
 * The backfill's scope, from `--derivation=<uuid>` or `--handle=<int> --role=<id>`.
 *
 * 🛑 Unscoped is the historical behaviour and stays the default, but it is rarely what you want for a
 * historical range: the recompute is delete-and-reinsert per detector, so a detector whose signal has
 * been re-pointed loses every row its current signal cannot reproduce (Daylesford's generator moved
 * to the DeepSea engine-speed point, whose history starts 2026-07-11). Scope, or know why not.
 */
function backfillFilter(): RunDetectorFilter | undefined {
  const derivation = arg("derivation");
  if (derivation) return { derivationId: derivation };
  const handle = num("handle");
  const role = arg("role");
  if (handle === undefined && !role) return undefined;
  if (handle === undefined || !role)
    throw new Error("--handle and --role must be given together");
  return { handle, role };
}

async function main() {
  if (SEED) return seed();
  const startMs = Date.parse(`${startStr}T00:00:00Z`);
  if (isNaN(startMs)) throw new Error(`Invalid --start: ${startStr}`);
  const nowMs = Date.now();
  const filter = backfillFilter();

  const trackers = await listEnabledRunDetectors(filter);
  console.log(
    `${tag} backfill ${new Date(startMs).toISOString()} .. ${new Date(nowMs).toISOString()} ` +
      `${filter ? `[scoped: ${describeFilter(filter)}] ` : "[ALL detectors — see --derivation/--handle+--role] "}` +
      `for ${trackers.length} enabled run detector(s): ${trackers.map((t) => `${t.legacyHandle}/${t.role}`).join(", ") || "(none)"}`,
  );

  if (trackers.length === 0) {
    console.log(
      filter
        ? "No enabled run detector matched that scope."
        : "No enabled run detectors — create a run-detector derivation for the area first.",
    );
    return;
  }
  if (!APPLY) {
    console.log(
      "Dry run — pass --apply to write. Recompute runs in 14-day chunks.",
    );
    return;
  }

  const started = nowMs;
  const summary = await recomputeRange(startMs, nowMs, nowMs, {
    filter,
    onProgress: (info) => {
      console.log(
        `  ${info.tracker} ${new Date(info.chunkStartMs).toISOString().slice(0, 10)}` +
          `..${new Date(info.chunkEndMs).toISOString().slice(0, 10)} → +${info.inserted}`,
      );
    },
  });
  console.log(
    `${tag} done in ${Math.round((Date.now() - started) / 1000)}s: ` +
      `${summary.rowsInserted} periods inserted, ${summary.rowsDeleted} deleted, ${summary.openPeriods} open.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
