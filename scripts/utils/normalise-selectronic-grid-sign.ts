/**
 * Flip the stored sign of a Selectronic `bidi.grid/power` point, and retire its read-time transform.
 *
 * WHY THIS EXISTS
 * The SP-PRO signs its AC-input port NEGATIVE while the house draws from it — the opposite of
 * LiveOne's canonical `bidi.*` convention (positive = inflow/import). Until 2026-09-17 that was
 * reconciled at READ time by `points.transform = 'i'`, in five separate places
 * (`lib/history/build-series.ts`, `lib/aggregation/flow-series.ts` via `applyPowerTransform`,
 * `lib/battery-provenance/load.ts`, `lib/collectors/interval-comparison.ts`, and the admin
 * point-readings route) — and the KV/latest path applied NONE of them. So `liveone device latest`
 * and `liveone device history` disagreed in sign on one point at one instant, and
 * `lib/automations/exercise.ts` reproduced the flip privately because it reads raw.
 *
 * The decoder now normalises at ingest (`transformSelectronicData`), so NEW readings land canonical.
 * This repairs the history so both halves agree, and clears the transform.
 *
 * ── 🛑 THIS REQUIRES A QUIESCED INGEST LANE, AND REFUSES WITHOUT ONE ─────────────────────────────
 *
 * It asserts at start-up that the `live` lane is paused and drained. That is not caution; it is
 * what makes the operation tractable, because it turns two hard problems into two trivial ones:
 *
 *  1. WHICH ROWS ARE LEGACY. With writes stopped, every row present is old-decoder by construction,
 *     so `max(measurement_time)` IS the boundary. Run this against a live table and it negates rows
 *     the new decoder already wrote canonically — and no deploy-timestamp heuristic fixes that,
 *     because an in-flight poll can land an OLDER measurement time after the cutover.
 *  2. HOW TO RESUME. Nothing below the watermark can change while we work, so "repaired up to T" is
 *     enough to restart from. Against a live table it would not be, and this would need a durable
 *     per-row original→target manifest instead.
 *
 * 🛑 The writes are chunked and non-transactional, so a crash DOES leave the table half-flipped.
 * The watermark file is what makes that recoverable: a re-run resumes from it rather than negating
 * everything again. Delete the watermark and re-run, and you corrupt the rows already done.
 *
 * `queue pause` only stops DISPATCH — publishing is unaffected and the outbox keeps accepting — so
 * nothing is lost while this runs. Resume afterwards and the queued readings land canonical.
 *
 * WHY NEGATE RATHER THAN REPLAY
 * The opposite call from `rebuild-sigenergy-readings.ts`, deliberately. That repair fixed three
 * defects at once, one of which DROPPED a field — so the rows could not be corrected arithmetically
 * and had to be recomputed from the archived payloads. This is a pure sign inversion of one column
 * of one point: negation is exactly the correction, and replaying 13 months through today's parser
 * would silently adopt every unrelated mapping change made since.
 *
 * USAGE — the full runbook is `docs/runbooks/selectronic-sign-cutover.md`. Do not run this on its
 * own; the steps either side of it are what make it safe.
 *
 *   npx tsx --env-file=.env.local scripts/utils/normalise-selectronic-grid-sign.ts            # dry run
 *   npx tsx --env-file=.env.local scripts/utils/normalise-selectronic-grid-sign.ts --apply
 *   … [--device=1] [--force-unpaused]   ← --force-unpaused is for a DEV database only
 */
import { and, eq } from "drizzle-orm";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { planetscaleDb } from "@/lib/db/planetscale";
import { points, devices } from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings/dao";
import { Point } from "@/lib/ids";
import type { PointId } from "@/lib/ids/types";
import { recomputeAgg5mForIntervals } from "@/lib/db/planetscale/aggregate-points-pg";
import { intervalEndForMs } from "@/lib/aggregation/point-aggregates";
import { readIngestState } from "@/lib/observations/flow-control";

const PAGE = 5000;
/** Intervals per aggregate transaction — see the lock note at the call site. */
const AGG_CHUNK = 2000;
const DAY_MS = 24 * 3600_000;

/** Where the resume watermark lives. Beside the repo, so a laptop restart does not lose it. */
const WATERMARK = ".selectronic-sign-watermark.json";

interface Watermark {
  pointId: string;
  /** Every reading with `measurement_time < this` has been negated. */
  repairedBelowMs: number;
  startedAt: string;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function readWatermark(pointId: string): Watermark | null {
  if (!existsSync(WATERMARK)) return null;
  const w = JSON.parse(readFileSync(WATERMARK, "utf8")) as Watermark;
  if (w.pointId !== pointId)
    fail(
      `the watermark at ${WATERMARK} is for ${w.pointId}, not ${pointId} — refusing to mix two repairs`,
    );
  return w;
}

interface Args {
  apply: boolean;
  deviceRid: number;
  forceUnpaused: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string) =>
    argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  return {
    apply: argv.includes("--apply"),
    deviceRid: Number(get("device") ?? 1),
    forceUnpaused: argv.includes("--force-unpaused"),
  };
}

/**
 * Refuse unless the live lane is paused AND drained.
 *
 * Drained matters as much as paused: `pause` stops new dispatch but says nothing about messages
 * already in flight, and one of those landing mid-repair would write an old-sign row below the
 * watermark — invisible to this run and to its validation.
 */
async function assertQuiesced(
  force: boolean,
  reportOnly: boolean,
): Promise<void> {
  // 🛑 `reportOnly` is how the DRY RUN exercises this. Without it the guard would be dead code
  // until the one run that matters, and the only way to find out whether it worked would be to
  // launch the real repair and hope it refused — which is exactly backwards for a check whose job
  // is to stop that repair. The dry run now answers "am I quiesced?" for free, on cutover day.
  const say = (msg: string) =>
    reportOnly ? console.warn(`⚠ ${msg}`) : fail(msg);

  if (force) {
    console.warn(
      "⚠ --force-unpaused: skipping the quiescence check. DEV ONLY — on prod this corrupts rows.",
    );
    return;
  }
  const state = await readIngestState();
  const live = state.lanes.find((l) => l.lane === "live");
  if (!live?.paused)
    return say(
      "the `live` ingest lane is NOT paused.\n" +
        "  Run: npm run liveone -- queue pause --lane live --apply --yes\n" +
        "  then wait for in-flight to reach 0 (npm run liveone -- queue status).\n" +
        "  Without this, rows the new decoder wrote canonically get negated back.",
    );
  if (live.inFlight > 0)
    return say(
      `the \`live\` lane is paused but ${live.inFlight} message(s) are still in flight — wait for them to land`,
    );
  console.log("quiesced:  live lane paused, nothing in flight ✓");
}

async function main() {
  const { apply, deviceRid, forceUnpaused } = parseArgs();
  const db = planetscaleDb;
  if (!db) fail("no database — run with `tsx --env-file=.env.local`");

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.rid, deviceRid))
    .limit(1);
  if (!device) fail(`device rid ${deviceRid} not found`);
  if (device.vendor !== "selectronic")
    fail(`device ${deviceRid} is '${device.vendor}', not selectronic`);

  const [point] = await db
    .select()
    .from(points)
    .where(
      and(
        eq(points.deviceId, device.id),
        eq(points.logicalPath, "bidi.grid"),
        eq(points.metricType, "power"),
      ),
    )
    .limit(1);
  if (!point) fail(`no bidi.grid/power point on device ${deviceRid}`);

  const pointId = Point.encode(point.id) as PointId;
  console.log(`device:    ${device.name} (rid ${deviceRid})`);
  console.log(`point:     ${pointId}  bidi.grid/power`);
  console.log(`transform: ${point.transform ?? "null"}`);

  const resume = readWatermark(pointId);
  if (resume)
    console.log(
      `resuming:  from ${new Date(resume.repairedBelowMs).toISOString()} (run started ${resume.startedAt})`,
    );

  // 🛑 The COMPLETION guard. `transform = 'i'` is what says "this column is still in the vendor's
  // sign"; it is cleared as the LAST step. A finished run therefore refuses to run again — but note
  // it says nothing about a run that DIED half way, which is what the watermark is for.
  if (point.transform !== "i")
    fail(
      `point.transform is '${point.transform ?? "null"}', not 'i' — this has already completed, ` +
        `or this point never stored the inverted sign. Refusing: negating again would undo it.`,
    );

  // Reported on a dry run, ENFORCED on an apply.
  await assertQuiesced(forceUnpaused, !apply);

  // Takes point RIDs, not `pt_` ids.
  const span = await ReadingsDao.rawSpanMsForPoints([point.rid]);
  if (!span) fail("no readings for this point — nothing to do");
  const fromMs = resume?.repairedBelowMs ?? span.minMs;
  console.log(
    `span:      ${new Date(fromMs).toISOString()} → ${new Date(span.maxMs).toISOString()}`,
  );

  let scanned = 0;
  let intended = 0;
  let updated = 0;
  let positives = 0;
  const touched = new Set<number>();
  let cursor = fromMs;
  const startedAt = resume?.startedAt ?? new Date().toISOString();

  while (cursor <= span.maxMs) {
    const to = Math.min(cursor + DAY_MS, span.maxMs + 1);
    const series = await ReadingsDao.readRaw([pointId], {
      fromMs: cursor,
      toMs: to,
      // 🛑 HALF-OPEN. The default upper bound is INCLUSIVE and the next page starts at this page's
      // `to` — so a reading landing exactly on a page boundary was read twice and negated twice,
      // i.e. left unchanged. Both counters counted the duplicate, so the row-count validation below
      // passed while the row was still wrong. The final page's `maxMs + 1` keeps the last reading.
      toInclusive: false,
    });
    const rows = series.get(pointId) ?? [];
    const updates = [];
    for (const r of rows) {
      scanned++;
      if (r.value === null) continue;
      if (r.value > 0) positives++;
      updates.push({
        point: pointId,
        measurementTimeMs: r.measurementTimeMs,
        // `+ 0` normalises -0, which would otherwise round-trip as "-0".
        value: -r.value + 0,
      });
      // 🛑 ENDS, not starts. `recomputeAgg5mForIntervals` addresses each bucket by its END and
      // covers `(end - 5m, end]`, so a reading at 12:03 belongs to 12:05. Flooring nominated a
      // bucket that does not contain the reading, leaving the real one stale.
      touched.add(intervalEndForMs(r.measurementTimeMs));
    }
    intended += updates.length;

    if (apply && updates.length > 0) {
      for (let i = 0; i < updates.length; i += PAGE) {
        const res = await ReadingsDao.updateRawValues(
          updates.slice(i, i + PAGE),
        );
        updated += res.updated;
      }
      // Advanced only once the WHOLE page has landed, never mid-page: a resume re-reads from the
      // watermark and negates what is stored, so a partially-written page must be redone in full.
      writeFileSync(
        WATERMARK,
        JSON.stringify(
          { pointId, repairedBelowMs: to, startedAt } satisfies Watermark,
          null,
          2,
        ),
      );
    }
    cursor = to;
  }

  console.log(`scanned:   ${scanned} readings`);
  console.log(
    `to negate: ${intended} (${scanned - intended} null, left alone)`,
  );
  // Informational, not a refusal. An off-grid site exports essentially nothing, so a large positive
  // count would mean the premise is wrong — a handful is ordinary sensor noise around zero. They
  // are negated like everything else: clamping them would be a separate data-cleaning policy.
  console.log(
    `positive:  ${positives} (${((positives / Math.max(scanned, 1)) * 100).toFixed(2)}% — these become negative, i.e. export)`,
  );
  console.log(`intervals: ${touched.size}`);

  if (!apply) {
    console.log("\ndry run — nothing written. Re-run with --apply.");
    return;
  }

  // 🛑 The migration-0056 lesson: assert the write did what the read said it would BEFORE touching
  // anything downstream. `updateRawValues` returns Postgres' `rowCount`, so this catches rows that
  // went missing — it does NOT establish uniqueness or correct sign, which is what the half-open
  // window and the quiescence check are for.
  if (updated !== intended)
    fail(
      `row-count mismatch: intended ${intended}, updated ${updated}. ` +
        `The watermark is kept — re-run to resume, do NOT delete it.`,
    );

  // 🛑 CHUNKED. `recomputeAgg5mForIntervals` takes one advisory lock and one transaction for the
  // whole call, then reads and upserts per interval across EVERY point on the device. Handing it
  // ~108,000 intervals would hold that lock for the duration and make the whole thing one rollback
  // away from starting over.
  const ends = [...touched].sort((a, b) => a - b);
  console.log(`\nrebuilding agg_5m over ${ends.length} intervals…`);
  let processed = 0;
  let upserted = 0;
  for (let i = 0; i < ends.length; i += AGG_CHUNK) {
    const agg = await recomputeAgg5mForIntervals(
      db,
      deviceRid,
      ends.slice(i, i + AGG_CHUNK),
    );
    processed += agg.intervalsProcessed;
    upserted += agg.rowsUpserted;
    process.stdout.write(
      `\r  ${Math.min(i + AGG_CHUNK, ends.length)}/${ends.length} intervals…`,
    );
  }
  console.log(`\n  ${processed} intervals, ${upserted} rows upserted`);

  // LAST, so the completion guard only closes once everything above has succeeded.
  await db
    .update(points)
    .set({ transform: null })
    .where(eq(points.id, point.id));
  console.log("cleared points.transform");
  if (existsSync(WATERMARK)) unlinkSync(WATERMARK);

  console.log(
    [
      "",
      "✅ raw + agg_5m are canonical (positive = import), transform retired.",
      "",
      "NEXT — in this order (see docs/runbooks/selectronic-sign-cutover.md):",
      "  1. npm run liveone -- queue resume --lane live --apply --yes",
      `  2. npm run liveone -- device recompute ${deviceRid} --start <first> --end <last> --apply`,
      "  3. POST /api/v4/areas/{ar_}/recompute-provenance   (loop on nextCursor)",
      "  4. verify: `device latest` and `device history` agree in sign",
      "",
      "🛑 NOT `liveone area purge flows` — it deletes days that rehealStaleAttrDays will never",
      "   look for again, and only an explicit recompute over the range restores them.",
    ].join("\n"),
  );
}

main().catch((e) => {
  console.error(e);
  console.error(
    `\n🛑 The watermark at ${WATERMARK} is kept. Re-run to resume; deleting it and re-running ` +
      `would negate the already-repaired rows a second time.`,
  );
  process.exit(1);
});
