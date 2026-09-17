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
 * ── WHICH ROWS ARE LEGACY: THE SESSION, NOT THE CLOCK ───────────────────────────────────────────
 *
 * A row is repaired iff `session_id IS NULL` OR its session was created before `--cutover`.
 *
 * 🛑 The session records when WE POLLED, not when the inverter sampled — and that is the whole
 * point. Every clock-based boundary fails the same way: a poll that fires after the cutover can
 * carry a vendor timestamp from before it, so `measurement_time` cannot tell an old-decoder row
 * from a new-decoder one. The session can, exactly, and however late the message lands.
 *
 * That makes the repair safe against LIVE INGEST. Earlier drafts paused the `live` lane and drained
 * it; that was abandoned because pausing stops DISPATCH, not POLLING — the collectors keep
 * publishing, so messages produced before the cutover sit in the outbox and land after the repair
 * has finished validating. Racing the pause against a fleet-wide lane is not winnable, and stopping
 * the poller instead would leave a PERMANENT hole: Selectronic is a live-poll vendor with no
 * history endpoint (`lib/vendors/sync-legs.ts` covers amber, sigenergy and openelectricity only),
 * so `liveone sync` refuses it rather than backfilling.
 *
 * NULL sessions are legacy by construction: on the live data they stop in June 2026, months before
 * any cutover, while session-bearing rows start 2025-11-04.
 *
 * 🛑 The writes are chunked and non-transactional, so a crash DOES leave the table half-flipped.
 * The watermark file is what makes that recoverable: a re-run resumes from it rather than negating
 * everything again. Delete the watermark and re-run, and you corrupt the rows already done.
 *
 * WHY NEGATE RATHER THAN REPLAY
 * The opposite call from `rebuild-sigenergy-readings.ts`, deliberately. That repair fixed three
 * defects at once, one of which DROPPED a field — so the rows could not be corrected arithmetically
 * and had to be recomputed from the archived payloads. This is a pure sign inversion of one column
 * of one point: negation is exactly the correction, and replaying 13 months through today's parser
 * would silently adopt every unrelated mapping change made since.
 *
 * USAGE — the runbook is `docs/runbooks/selectronic-sign-cutover.md`.
 *
 *   … normalise-selectronic-grid-sign.ts --cutover=2026-09-18T00:00:00Z            # dry run
 *   … normalise-selectronic-grid-sign.ts --cutover=2026-09-18T00:00:00Z --apply
 *   … [--device=1]
 *
 * `--cutover` is the instant the new decoder went live. Take it from the deployment, and err
 * EARLY rather than late: a cutover before the deploy leaves a few new-sign rows unrepaired, which
 * is visible and fixable; one after it negates canonical rows, which is not.
 */
import { and, eq, lt } from "drizzle-orm";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { planetscaleDb } from "@/lib/db/planetscale";
import { points, devices, sessions } from "@/lib/db/planetscale/schema";
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
  cutoverMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string) =>
    argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const cutover = get("cutover");
  if (!cutover)
    fail(
      "--cutover=<ISO> is required: the instant the new decoder went live.\n" +
        "  Rows from polls BEFORE it are repaired; rows from polls after it are already canonical.\n" +
        "  Err EARLY — too early leaves a few visible rows unrepaired, too late destroys good ones.",
    );
  const cutoverMs = Date.parse(cutover);
  if (Number.isNaN(cutoverMs))
    fail(`--cutover=${cutover} is not a parseable instant`);
  return {
    apply: argv.includes("--apply"),
    deviceRid: Number(get("device") ?? 1),
    cutoverMs,
  };
}

/**
 * The set of sessions that predate the cutover — i.e. the polls the OLD decoder produced.
 *
 * Loaded once, up front, as a Set. `sessions` is a config-ish table for this device (~one row per
 * poll), so this is bounded by the device's own history rather than by the readings count, and it
 * turns the per-row test into a hash lookup instead of 534k joins.
 *
 * 🛑 Scoped to the DEVICE. A session id is globally unique, so an unscoped load would pull every
 * vendor's polls and answer the same question far more expensively.
 */
async function legacySessionIds(
  db: NonNullable<typeof planetscaleDb>,
  deviceRid: number,
  cutoverMs: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.deviceRid, deviceRid),
        lt(sessions.createdAt, new Date(cutoverMs)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

async function main() {
  const { apply, deviceRid, cutoverMs } = parseArgs();
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

  console.log(`cutover:   ${new Date(cutoverMs).toISOString()}`);
  const legacy = await legacySessionIds(db, deviceRid, cutoverMs);
  console.log(`legacy:    ${legacy.size} session(s) predate the cutover`);

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
  let skippedCanonical = 0;
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
      // 🛑 THE BOUNDARY. A NULL session is legacy by construction (they stop months before any
      // cutover); a session we loaded is one that polled BEFORE the cutover, so its row carries the
      // old decoder's sign however late the message landed. Anything else was written by the new
      // decoder and is already canonical — negating it would be the one unrecoverable mistake here.
      if (r.sessionId !== null && !legacy.has(r.sessionId)) {
        skippedCanonical++;
        continue;
      }
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
    `to negate: ${intended}  (skipped ${skippedCanonical} already-canonical, ` +
      `${scanned - intended - skippedCanonical} null-valued)`,
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
