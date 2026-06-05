#!/usr/bin/env tsx
/**
 * Phase 2 backfill: copy historical sessions + readings from Turso into the Postgres
 * mirror, in parallel. Turso stays the source of truth; this fills everything that
 * predates the live (Phase 1) pipeline. See docs/observations-pg-phase2.md.
 *
 * Direct Turso→Postgres streaming (NOT via QStash). Properties:
 *   - SHARDED parallelism: each table's key-space is split into N ranges, each driven by
 *     an independent worker (read Turso → upsert PG) concurrently. Throughput ≈ N× a single
 *     stream, bounded by Turso/PG capacity. Cross-shard work overlaps read+write latency.
 *   - Batched + idempotent: every write is upsert / do-nothing, so re-runs and overlap with
 *     the live pipeline never duplicate.
 *   - Resumable: a per-shard checkpoint row (`<table>#<i>`) is saved after every page; a
 *     crash/Ctrl-C re-does at most one page per shard.
 *   - Transient-tolerant: each write retries through managed-PG connection drops (57P01/08xxx).
 *   - Live: a dashboard repaints ~4×/s showing per-shard phase, aggregate rate and ETA —
 *     never silent, even during slow round-trips. Row totals are counted in the background.
 *
 * Order: sessions before readings (point_readings.sessionId → sessions.id).
 * Controls (TTY): [p]ause  [r]esume  [c]ancel (Ctrl-C also cancels).
 *
 * Usage:
 *   NODE_ENV=production npx tsx scripts/backfill-turso-to-postgres.ts            # dry run
 *   NODE_ENV=production npx tsx scripts/backfill-turso-to-postgres.ts --apply
 *   …--apply --table=point_readings --shards=16     # one table, 16-way
 *   …--apply --table=point_readings --limit=200000  # stop after ~N rows (smoke test)
 *   …--apply --reset                                 # forget checkpoints, redo
 *
 * Notes:
 *   --shards is PINNED per table on the first run (stored in backfill_progress as
 *     `<table>#meta`); resuming with a different --shards is ignored unless you --reset.
 *   --limit is best-effort across shards: it stops at the next page boundary, so the run
 *     can overshoot by up to ~shards × page (10k) rows. Intended for smoke tests only.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import * as fs from "fs";
import { sql, and, gt, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  pointReadings as tPR,
  pointReadingsAgg5m as tA5,
  pointReadingsAgg1d as tA1,
} from "@/lib/db/turso/schema-monitoring-points";
import { sessions as tSessions } from "@/lib/db/turso/schema";
import * as pgSchema from "@/lib/db/planetscale/schema";
const {
  sessions: pgSessions,
  pointReadings: pgPR,
  pointReadingsAgg5m: pgA5,
  pointReadingsAgg1d: pgA1,
} = pgSchema;

const PAGE = 10_000; // rows read per page per shard
const WRITE = 2_000; // rows per Postgres INSERT
const MAX_RETRY = 6; // per-write retries on transient disconnects
const TABLES = ["sessions", "point_readings", "agg_5m", "agg_1d"] as const;
type TableName = (typeof TABLES)[number];

const ex = (col: string) => sql.raw(`excluded."${col}"`);
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
function fmtDur(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function bar(frac: number, width = 22): string {
  const full = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return "▕" + "█".repeat(full) + "░".repeat(width - full) + "▏";
}

// ── transient-retry ────────────────────────────────────────────────────────
// 40P01 deadlock / 40001 serialization_failure can occur from concurrent shard upserts
// touching the same arbiter (e.g. two sessions shards on the same (system_id,created_at));
// the writes are idempotent so retrying an aborted batch is safe.
const TRANSIENT = [
  "40P01",
  "40001",
  "57P01",
  "57P02",
  "57P03",
  "08006",
  "08003",
  "08000",
  "53300",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "Connection terminated",
];
async function withRetry<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, code: string) => void,
  opts?: { sleep?: (ms: number) => Promise<void>; abort?: () => boolean },
): Promise<T> {
  const sleep =
    opts?.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const code = String(e?.code ?? e?.cause?.code ?? "");
      const msg =
        String(e?.message ?? "") + " " + String(e?.cause?.message ?? "");
      const transient = TRANSIENT.some((t) => code === t || msg.includes(t));
      if (!transient || attempt >= MAX_RETRY || opts?.abort?.()) throw e;
      onRetry(attempt, code || msg.trim().slice(0, 40));
      await sleep(Math.min(500 * 2 ** (attempt - 1), 10_000));
      if (opts?.abort?.()) throw e;
    }
  }
}

// ── shard state + live dashboard ─────────────────────────────────────────────
type Phase = "wait" | "read" | "write" | "done";
interface Shard {
  i: number;
  lo: number;
  hi: number;
  cursor: any;
  done: number; // rows processed by this shard (incl. resumed)
  startDone: number;
  phase: Phase;
  retries: number;
}

const TTY = process.stdout.isTTY === true;
let prevLines = 0;
function clearBlock() {
  if (!TTY || prevLines === 0) return;
  process.stdout.write(`\x1b[${prevLines}A`);
  for (let i = 0; i < prevLines; i++) process.stdout.write("\r\x1b[2K\n");
  process.stdout.write(`\x1b[${prevLines}A`);
  prevLines = 0;
}
/** Print a permanent line above the live dashboard block. */
function logAbove(msg: string) {
  clearBlock();
  console.log(msg);
}
function draw(lines: string[]) {
  if (!TTY) {
    // Off-TTY (piped/background): no cursor control — emit just the headline, plainly.
    console.log(lines[0]);
    return;
  }
  const w = (process.stdout.columns || 100) - 1;
  let out = prevLines > 0 ? `\x1b[${prevLines}A` : "";
  for (const l of lines)
    out += "\r\x1b[2K" + (l.length > w ? l.slice(0, w) : l) + "\n";
  process.stdout.write(out);
  prevLines = lines.length;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const reset = args.includes("--reset");
  const limit =
    Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 0;
  const shardsArg =
    Number(args.find((a) => a.startsWith("--shards="))?.split("=")[1]) || 0;
  const writersArg =
    Number(args.find((a) => a.startsWith("--writers="))?.split("=")[1]) || 0;
  const logPath = args.find((a) => a.startsWith("--log="))?.split("=")[1];
  const verify = args.includes("--verify");
  const only = args.find((a) => a.startsWith("--table="))?.split("=")[1] as
    | TableName
    | undefined;
  const selected = only ? [only] : [...TABLES];

  // Chatty timestamped log (synchronous append → reliable to `tail -f` and flushed on crash).
  const L = (msg: string) => {
    if (logPath)
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  };
  L(
    `run start apply=${apply} reset=${reset} shards=${shardsArg || "default"} writers=${writersArg || "default"} limit=${limit || 0} tables=${selected.join(",")}`,
  );

  const { db: turso, rawClient } = await import("@/lib/db/turso");

  // Dedicated PG pool sized for the shard fan-out (independent of the app's max=10).
  const url = process.env.PLANETSCALE_DATABASE_URL;
  const host = process.env.DB_HOST;
  // SHARDS = read-parallelism (Turso). WRITERS = max concurrent PG writes — kept low and
  // DECOUPLED from shards, because the managed PG (PgBouncer-fronted) chokes and drops
  // connections (57P01) when flooded with many concurrent writers, which triggers a
  // retry/backoff storm that is far SLOWER than a handful of steady writers.
  const SHARDS = shardsArg || 8;
  const WRITERS = Math.min(writersArg || 6, SHARDS);
  const common = {
    max: WRITERS + 4,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
  };
  const poolConfig = url
    ? { connectionString: url, ...common }
    : host
      ? {
          host,
          port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
          database: process.env.DB_DATABASE,
          user: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          ssl: ["0", "false", "disable", "disabled"].includes(
            (process.env.DB_SSL ?? "").toLowerCase(),
          )
            ? false
            : { rejectUnauthorized: false },
          ...common,
        }
      : null;
  if (!poolConfig) {
    console.error(
      "❌ Postgres not configured (PLANETSCALE_DATABASE_URL / DB_*). Aborting.",
    );
    process.exit(1);
  }
  const pool = new Pool(poolConfig);
  pool.on("error", () => {}); // transient pool errors handled per-write by withRetry
  const pg = drizzle(pool, { schema: pgSchema });

  // ── interactive controls + write throttle ────────────────────────────────────
  let paused = false;
  let cancelled = false;
  const pauseWaiters: (() => void)[] = [];
  const cancelWaiters: (() => void)[] = [];
  const wake = () => pauseWaiters.splice(0).forEach((fn) => fn());
  async function gate() {
    while (paused && !cancelled)
      await new Promise<void>((r) => pauseWaiters.push(r));
  }
  // Sleep that returns early on cancel, so a retry backoff never blocks a [c]ancel.
  const sleep = (ms: number) =>
    cancelled
      ? Promise.resolve()
      : new Promise<void>((res) => {
          const w = () => {
            clearTimeout(t);
            res();
          };
          const t = setTimeout(() => {
            const i = cancelWaiters.indexOf(w);
            if (i >= 0) cancelWaiters.splice(i, 1);
            res();
          }, ms);
          cancelWaiters.push(w);
        });
  const signalCancel = () => {
    cancelled = true;
    paused = false;
    wake();
    cancelWaiters.splice(0).forEach((w) => w());
    L("cancel requested");
  };

  // Global throttle: at most WRITERS concurrent PG writes, regardless of shard count —
  // keeps the managed PG out of the connection-drop/retry storm that kills throughput.
  const writeSem = (() => {
    let active = 0;
    const q: (() => void)[] = [];
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      if (active >= WRITERS) await new Promise<void>((r) => q.push(r));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        q.shift()?.();
      }
    };
  })();
  if (apply && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (k: string) => {
      if (k === "\u0003" || k === "c" || k === "q") signalCancel();
      else if (k === "p") {
        paused = true;
        L("pause");
      } else if (k === "r") {
        paused = false;
        wake();
        L("resume");
      }
    });
  }

  console.log("─".repeat(80));
  console.log(
    `Backfill Turso → Postgres   ${apply ? "APPLY" : "DRY RUN"}${reset ? " +reset" : ""}${limit ? `  limit=${fmtInt(limit)}` : ""}  shards=${SHARDS}`,
  );
  if (apply && process.stdin.isTTY)
    console.log("controls: [p]ause  [r]esume  [c]ancel");
  console.log("─".repeat(80));

  await pg.execute(sql`
    CREATE TABLE IF NOT EXISTS backfill_progress (
      table_name text PRIMARY KEY,
      cursor jsonb, rows_done bigint NOT NULL DEFAULT 0,
      done boolean NOT NULL DEFAULT false, updated_at timestamp NOT NULL DEFAULT now()
    )`);
  if (reset && apply) {
    for (const t of selected)
      await pg.execute(
        sql`DELETE FROM backfill_progress WHERE table_name LIKE ${t.replace(/[%_\\]/g, "\\$&") + "#%"} ESCAPE '\\' OR table_name = ${t}`,
      );
    logAbove("Reset checkpoints for selected tables.");
  }

  async function loadShard(key: string) {
    const r = await pg.execute(
      sql`SELECT cursor, rows_done, done FROM backfill_progress WHERE table_name = ${key}`,
    );
    const row = (r.rows as any[])[0];
    return {
      cursor: row?.cursor ?? null,
      rowsDone: Number(row?.rows_done ?? 0),
      done: Boolean(row?.done ?? false),
    };
  }
  async function saveShard(
    key: string,
    cursor: any,
    rowsDone: number,
    done: boolean,
  ) {
    await pg.execute(sql`
      INSERT INTO backfill_progress (table_name, cursor, rows_done, done, updated_at)
      VALUES (${key}, ${JSON.stringify(cursor)}::jsonb, ${rowsDone}, ${done}, now())
      ON CONFLICT (table_name) DO UPDATE SET cursor = excluded.cursor, rows_done = excluded.rows_done, done = excluded.done, updated_at = now()`);
  }
  const tursoCount = async (q: any) => Number((await q)[0].c);
  const pgCount = async (t: string) =>
    Number(
      (await pg.execute(sql.raw(`SELECT count(*)::int c FROM ${t}`))).rows[0].c,
    );

  /**
   * Generic sharded table backfill. `def` plugs in how to bound/split the key-space,
   * read a page within a shard, advance the cursor, and map+write rows.
   */
  async function runTable(
    name: TableName,
    def: {
      shards: number;
      bounds: () => Promise<{ min: number; max: number }>; // numeric shard axis (id or interval_end)
      count: () => Promise<number>;
      initCursor: (lo: number) => any;
      readPage: (lo: number, hi: number, cursor: any) => Promise<any[]>;
      nextCursor: (row: any) => any;
      map: (rows: any[]) => any[];
      write: (chunk: any[], onRetry: (n: number) => void) => Promise<void>;
      finalize?: () => Promise<void>; // e.g. setval after sessions
    },
  ) {
    // Pin the shard geometry (min/max/nShards) on the first apply run and reuse it on every
    // resume, so each shard's [lo,hi] is deterministic even though the live `max` keeps
    // growing and --shards could change. Without this, a stale per-shard cursor would be
    // misapplied to a shifted range → silently skipped rows + a false "done". `max` is the
    // snapshot upper bound (rows above it are the live pipeline's job). --reset clears #meta.
    const clampShards = (mn: number, mx: number) =>
      Math.max(1, Math.min(def.shards, mx - mn + 1 > 0 ? mx - mn + 1 : 1));
    let min: number, max: number, nShards: number;
    const metaKey = `${name}#meta`;
    if (apply) {
      const meta = await loadShard(metaKey);
      if (meta.cursor && typeof meta.cursor.min === "number") {
        ({ min, max, nShards } = meta.cursor as {
          min: number;
          max: number;
          nShards: number;
        });
        if (shardsArg && shardsArg !== nShards)
          logAbove(
            `  note: ${name} is pinned to ${nShards} shards from its first run — use --reset to re-shard.`,
          );
      } else {
        const b = await def.bounds();
        min = b.min;
        max = b.max;
        nShards = clampShards(min, max);
        await saveShard(metaKey, { min, max, nShards }, 0, false);
      }
    } else {
      const b = await def.bounds();
      min = b.min;
      max = b.max;
      nShards = clampShards(min, max);
    }
    const span = max - min + 1;
    const size = Math.ceil(span / nShards);

    const shards: Shard[] = [];
    let allDone = true;
    for (let i = 0; i < nShards; i++) {
      const lo = min + i * size;
      const hi = i === nShards - 1 ? max : Math.min(max, lo + size - 1);
      const cp = await loadShard(`${name}#${i}`);
      if (!cp.done) allDone = false;
      shards.push({
        i,
        lo,
        hi,
        cursor: cp.cursor ?? def.initCursor(lo),
        done: cp.rowsDone,
        startDone: cp.rowsDone,
        phase: cp.done ? "done" : "wait",
        retries: 0,
      });
    }

    if (!apply) {
      const total = await def.count();
      const done = shards.reduce((s, x) => s + x.done, 0);
      logAbove(
        `• ${name.padEnd(14)} ${fmtInt(done)} / ${fmtInt(total)} done  (${nShards} shards${allDone ? ", complete" : ""})`,
      );
      return;
    }
    if (allDone) {
      logAbove(`✓ ${name.padEnd(14)} already complete`);
      return;
    }

    // Background row count → fills the % once it lands; copying starts immediately.
    let total = 0;
    const counting = def
      .count()
      .then((n) => {
        total = n;
      })
      .catch(() => {});

    const tStart = Date.now();
    const doneAtStart = shards.reduce((s, x) => s + x.done, 0);
    let processedThisRun = 0;
    let stoppedByLimit = false;
    L(
      `${name} START shards=${nShards} writers=${WRITERS} min=${min} max=${max} span=${span} resumeDone=${doneAtStart}`,
    );

    const worker = async (sh: Shard) => {
      if (sh.phase === "done") return;
      L(
        `${name}#${sh.i} begin range=[${sh.lo},${sh.hi}] cursor=${JSON.stringify(sh.cursor)} done=${sh.done}`,
      );
      for (;;) {
        await gate();
        if (cancelled || (limit && processedThisRun >= limit)) {
          stoppedByLimit = !!(limit && processedThisRun >= limit);
          break;
        }
        sh.phase = "read";
        const t0 = Date.now();
        const rows = await def.readPage(sh.lo, sh.hi, sh.cursor);
        L(`${name}#${sh.i} read rows=${rows.length} (${Date.now() - t0}ms)`);
        if (rows.length === 0) {
          sh.phase = "done";
          break;
        }
        sh.phase = "write";
        const mapped = def.map(rows);
        for (let i = 0; i < mapped.length; i += WRITE) {
          if (cancelled) break;
          const chunk = mapped.slice(i, i + WRITE);
          const w0 = Date.now();
          await writeSem(() =>
            withRetry(
              () => def.write(chunk, () => {}),
              (n, code) => {
                sh.retries++;
                L(`${name}#${sh.i} RETRY ${n}/${MAX_RETRY - 1} code=${code}`);
              },
              { sleep, abort: () => cancelled },
            ),
          );
          sh.done += chunk.length; // per-chunk live progress
          processedThisRun += chunk.length;
          L(
            `${name}#${sh.i} wrote=${chunk.length} shardDone=${sh.done} (${Date.now() - w0}ms)`,
          );
        }
        if (cancelled) break;
        sh.cursor = def.nextCursor(rows[rows.length - 1]);
        await saveShard(`${name}#${sh.i}`, sh.cursor, sh.done, false);
        L(
          `${name}#${sh.i} ckpt done=${sh.done} cursor=${JSON.stringify(sh.cursor)}`,
        );
      }
      if (sh.phase === "done") {
        await saveShard(`${name}#${sh.i}`, sh.cursor, sh.done, true);
        L(`${name}#${sh.i} COMPLETE done=${sh.done}`);
      }
    };

    // ── live dashboard (repaints ~4×/s; never silent) ──────────────────────────
    const render = () => {
      const done = shards.reduce((s, x) => s + x.done, 0);
      const rate =
        (done - doneAtStart) / Math.max(0.001, (Date.now() - tStart) / 1000);
      const rateStr =
        rate >= 1000
          ? `${(rate / 1000).toFixed(1)}k/s`
          : `${Math.round(rate)}/s`;
      const reading = shards.filter((s) => s.phase === "read").length;
      const writing = shards.filter((s) => s.phase === "write").length;
      const fin = shards.filter((s) => s.phase === "done").length;
      const retries = shards.reduce((s, x) => s + x.retries, 0);
      const head =
        total > 0
          ? `${name.padEnd(14)} ${bar(Math.min(1, done / total))} ${Math.floor((done / total) * 100)}%  ${fmtInt(done)}/${fmtInt(total)}  ${rateStr}  ETA ${fmtDur(rate > 0 ? ((total - done) / rate) * 1000 : Infinity)}`
          : `${name.padEnd(14)} ⟳ ${fmtInt(done)} rows  ${rateStr}  (counting…)`;
      const status = `  ${nShards} shards · reading ${reading} · writing ${writing} · done ${fin}/${nShards} · retries ${retries} · ${fmtDur(Date.now() - tStart)}${paused ? "   ⏸ PAUSED" : ""}${cancelled ? "   ✖ cancelling…" : ""}`;
      draw([head, status]);
    };
    const timer = setInterval(render, TTY ? 250 : 4000);
    render();

    // A fresh worker failure (non-transient, or retries exhausted) signals siblings to stop;
    // errors that arrive after a cancel is already in flight are expected and swallowed. The
    // dashboard is always torn down before we rethrow a real failure.
    let workerError: any = null;
    const runOne = async (sh: Shard) => {
      try {
        await worker(sh);
      } catch (e: any) {
        if (!cancelled) {
          workerError = workerError ?? e;
          L(
            `${name}#${sh.i} FAILED ${e?.code ?? ""} ${String(e?.message ?? e).slice(0, 120)}`,
          );
          signalCancel();
        }
      }
    };
    try {
      await Promise.all(shards.map(runOne));
      if (!cancelled) await counting;
    } finally {
      clearInterval(timer);
      render();
      clearBlock();
    }
    if (workerError) throw workerError;

    if (cancelled) {
      L(`${name} cancelled at ${shards.reduce((s, x) => s + x.done, 0)} rows`);
      logAbove(
        `✖ ${name}: cancelled at ${fmtInt(shards.reduce((s, x) => s + x.done, 0))} rows (per-shard checkpoints saved).`,
      );
      return;
    }
    if (stoppedByLimit) {
      logAbove(
        `⏸ ${name}: stopped at --limit (${fmtInt(processedThisRun)} rows this run). Checkpoints saved; not complete.`,
      );
      return;
    }
    if (def.finalize) await def.finalize();
    logAbove(
      `✓ ${name.padEnd(14)} ${fmtInt(shards.reduce((s, x) => s + x.done, 0))} rows  in ${fmtDur(Date.now() - tStart)}`,
    );
  }

  // ── table definitions ───────────────────────────────────────────────────────
  const idBounds = (t: any) => async () => {
    const [{ mn, mx }] = await turso
      .select({
        mn: sql<number>`coalesce(min(id),0)`,
        mx: sql<number>`coalesce(max(id),0)`,
      })
      .from(t);
    return { min: Number(mn), max: Number(mx) };
  };

  async function sessions() {
    await runTable("sessions", {
      shards: SHARDS,
      bounds: idBounds(tSessions),
      count: () =>
        tursoCount(turso.select({ c: sql<number>`count(*)` }).from(tSessions)),
      initCursor: (lo) => ({ id: lo - 1 }),
      readPage: (lo, hi, c) =>
        turso
          .select()
          .from(tSessions)
          .where(and(gt(tSessions.id, c.id), lte(tSessions.id, hi)))
          .orderBy(tSessions.id)
          .limit(PAGE),
      nextCursor: (r) => ({ id: r.id }),
      map: (rows) =>
        rows.map((r) => ({
          id: r.id,
          sessionLabel: r.sessionLabel,
          systemId: r.systemId,
          cause: r.cause,
          duration: r.duration,
          successful: r.successful,
          errorCode: r.errorCode,
          error: r.error,
          // Skip the historical `response` JSONB blob — it's a large audit/debug payload
          // (~3KB/row) that dominates session write cost (~30s per 2k-row chunk) for marginal
          // value in the mirror. Live sessions keep their full response via the Phase-1 consumer.
          response: null,
          numRows: r.numRows,
          createdAt: r.started,
        })),
      // DO NOTHING (no target): PG sessions has TWO uniques (id PK + system_id/created_at)
      // while Turso sessions are only unique on id. Skip a conflict on EITHER.
      write: (chunk) =>
        pg
          .insert(pgSessions)
          .values(chunk)
          .onConflictDoNothing()
          .then(() => undefined),
      finalize: () =>
        pg
          .execute(
            sql`SELECT setval(pg_get_serial_sequence('sessions','id'), GREATEST((SELECT MAX(id) FROM sessions), 1))`,
          )
          .then(() => undefined),
    });
  }

  async function pointReadings() {
    await runTable("point_readings", {
      shards: SHARDS,
      bounds: idBounds(tPR),
      count: () =>
        tursoCount(turso.select({ c: sql<number>`count(*)` }).from(tPR)),
      initCursor: (lo) => ({ id: lo - 1 }),
      readPage: (lo, hi, c) =>
        turso
          .select()
          .from(tPR)
          .where(and(gt(tPR.id, c.id), lte(tPR.id, hi)))
          .orderBy(tPR.id)
          .limit(PAGE),
      nextCursor: (r) => ({ id: r.id }),
      map: (rows) =>
        rows.map((r) => ({
          systemId: r.systemId,
          pointId: r.pointId,
          sessionId: r.sessionId,
          measurementTime: new Date(r.measurementTimeMs),
          receivedTime: new Date(r.receivedTimeMs),
          value: r.value,
          valueStr: r.valueStr,
          error: r.error,
          dataQuality: r.dataQuality,
          createdAt: new Date(r.receivedTimeMs), // backfill marker (keeps off the live ingest chart)
        })),
      write: (chunk) =>
        pg
          .insert(pgPR)
          .values(chunk)
          .onConflictDoNothing()
          .then(() => undefined),
    });
  }

  async function agg5m() {
    await runTable("agg_5m", {
      shards: SHARDS,
      bounds: async () => {
        const [{ mn, mx }] = await turso
          .select({
            mn: sql<number>`coalesce(min(interval_end),0)`,
            mx: sql<number>`coalesce(max(interval_end),0)`,
          })
          .from(tA5);
        return { min: Number(mn), max: Number(mx) };
      },
      count: () =>
        tursoCount(turso.select({ c: sql<number>`count(*)` }).from(tA5)),
      initCursor: (lo) => ({ ie: lo - 1, sid: -1, pid: -1 }),
      readPage: (lo, hi, c) =>
        turso
          .select()
          .from(tA5)
          .where(
            and(
              gte(tA5.intervalEnd, lo),
              lte(tA5.intervalEnd, hi),
              sql`(${tA5.intervalEnd}, ${tA5.systemId}, ${tA5.pointId}) > (${c.ie}, ${c.sid}, ${c.pid})`,
            ),
          )
          .orderBy(tA5.intervalEnd, tA5.systemId, tA5.pointId)
          .limit(PAGE),
      nextCursor: (r) => ({
        ie: r.intervalEnd,
        sid: r.systemId,
        pid: r.pointId,
      }),
      map: (rows) =>
        rows.map((r) => ({
          systemId: r.systemId,
          pointId: r.pointId,
          intervalEnd: new Date(r.intervalEnd),
          sessionId: r.sessionId,
          avg: r.avg,
          min: r.min,
          max: r.max,
          last: r.last,
          delta: r.delta,
          valueStr: r.valueStr,
          sampleCount: r.sampleCount,
          errorCount: r.errorCount,
          dataQuality: r.dataQuality,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        })),
      write: (chunk) =>
        pg
          .insert(pgA5)
          .values(chunk)
          .onConflictDoUpdate({
            target: [pgA5.systemId, pgA5.pointId, pgA5.intervalEnd],
            set: {
              sessionId: ex("session_id"),
              avg: ex("avg"),
              min: ex("min"),
              max: ex("max"),
              last: ex("last"),
              delta: ex("delta"),
              valueStr: ex("value_str"),
              sampleCount: ex("sample_count"),
              errorCount: ex("error_count"),
              dataQuality: ex("data_quality"),
              updatedAt: ex("updated_at"),
            },
          })
          .then(() => undefined),
    });
  }

  async function agg1d() {
    await runTable("agg_1d", {
      shards: 1, // tiny table
      bounds: async () => ({ min: 0, max: 0 }),
      count: () =>
        tursoCount(turso.select({ c: sql<number>`count(*)` }).from(tA1)),
      initCursor: () => ({ day: "", sid: -1, pid: -1 }),
      readPage: (lo, hi, c) =>
        turso
          .select()
          .from(tA1)
          .where(
            sql`(${tA1.day}, ${tA1.systemId}, ${tA1.pointId}) > (${c.day}, ${c.sid}, ${c.pid})`,
          )
          .orderBy(tA1.day, tA1.systemId, tA1.pointId)
          .limit(PAGE),
      nextCursor: (r) => ({ day: r.day, sid: r.systemId, pid: r.pointId }),
      map: (rows) =>
        rows.map((r) => ({
          systemId: r.systemId,
          pointId: r.pointId,
          day: r.day,
          avg: r.avg,
          min: r.min,
          max: r.max,
          last: r.last,
          delta: r.delta,
          sampleCount: r.sampleCount,
          errorCount: r.errorCount,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        })),
      write: (chunk) =>
        pg
          .insert(pgA1)
          .values(chunk)
          .onConflictDoUpdate({
            target: [pgA1.systemId, pgA1.pointId, pgA1.day],
            set: {
              avg: ex("avg"),
              min: ex("min"),
              max: ex("max"),
              last: ex("last"),
              delta: ex("delta"),
              sampleCount: ex("sample_count"),
              errorCount: ex("error_count"),
              updatedAt: ex("updated_at"),
            },
          })
          .then(() => undefined),
    });
  }

  // ── verify (read-only): every Turso record present in Postgres ───────────────
  // Compares per-UTC-day bucket counts of the BUSINESS KEY between Turso and PG. PG only
  // ever holds keys sourced from Turso (backfill or dual-write), so PG ⊆ Turso; therefore
  // equal per-bucket counts ⟹ identical key sets ⟹ not a single record dropped. Bucketing
  // (vs one grand total) catches a drop in one region that a live-write surplus elsewhere
  // would otherwise mask. Today's bucket can legitimately differ by the live in-flight tail
  // (rows written to Turso whose queue message PG hasn't consumed yet) — reported separately.
  async function verifyTable(
    name: string,
    tursoSql: string,
    pgSql: string,
  ): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const [tr, pr] = await Promise.all([
      rawClient.execute(tursoSql),
      pg.execute(sql.raw(pgSql)),
    ]);
    const pmap = new Map(
      (pr.rows as any[]).map((r) => [String(r.b), Number(r.c)]),
    );
    let missing = 0,
      tail = 0;
    const bad: string[] = [];
    for (const row of tr.rows as any[]) {
      const k = String(row.b),
        tc = Number(row.c),
        pc = pmap.get(k) ?? 0;
      if (tc > pc) {
        if (k >= today) tail += tc - pc;
        else {
          missing += tc - pc;
          bad.push(`${k}: turso=${tc} pg=${pc} missing=${tc - pc}`);
        }
      }
    }
    if (missing === 0)
      logAbove(
        `  ✓ ${name.padEnd(14)} no records dropped · ${(tr.rows as any[]).length} day-buckets checked${tail ? ` · ${tail} in today's live-tail (in-flight, not a drop)` : ""}`,
      );
    else {
      logAbove(
        `  ✗ ${name.padEnd(14)} ${fmtInt(missing)} RECORDS MISSING across ${bad.length} day(s):`,
      );
      bad.slice(0, 15).forEach((b) => logAbove(`       ${b}`));
      if (bad.length > 15)
        logAbove(`       … and ${bad.length - 15} more days`);
    }
    return missing;
  }
  if (verify) {
    logAbove("─".repeat(80));
    logAbove(
      "Verify — every Turso record present in Postgres (per-day key-count reconciliation):",
    );
    let gm = 0;
    if (selected.includes("sessions"))
      gm += await verifyTable(
        "sessions",
        `SELECT strftime('%Y-%m-%d', started, 'unixepoch') b, COUNT(DISTINCT system_id || '|' || started) c FROM sessions GROUP BY b`,
        `SELECT to_char(created_at,'YYYY-MM-DD') b, count(*) c FROM sessions GROUP BY b`,
      );
    if (selected.includes("point_readings"))
      gm += await verifyTable(
        "point_readings",
        `SELECT strftime('%Y-%m-%d', measurement_time/1000, 'unixepoch') b, COUNT(*) c FROM point_readings GROUP BY b`,
        `SELECT to_char(measurement_time,'YYYY-MM-DD') b, count(*) c FROM point_readings GROUP BY b`,
      );
    if (selected.includes("agg_5m"))
      gm += await verifyTable(
        "agg_5m",
        `SELECT strftime('%Y-%m-%d', interval_end/1000, 'unixepoch') b, COUNT(*) c FROM point_readings_agg_5m GROUP BY b`,
        `SELECT to_char(interval_end,'YYYY-MM-DD') b, count(*) c FROM point_readings_agg_5m GROUP BY b`,
      );
    if (selected.includes("agg_1d"))
      gm += await verifyTable(
        "agg_1d",
        `SELECT day b, COUNT(*) c FROM point_readings_agg_1d GROUP BY b`,
        `SELECT day b, count(*) c FROM point_readings_agg_1d GROUP BY b`,
      );
    logAbove("─".repeat(80));
    logAbove(
      gm === 0
        ? "✅ VERIFIED — not a single historical record dropped."
        : `❌ ${fmtInt(gm)} historical records missing from Postgres (see above).`,
    );
    L(`verify done missing=${gm}`);
    await pool.end();
    return;
  }

  const runners: Record<TableName, () => Promise<void>> = {
    sessions,
    point_readings: pointReadings,
    agg_5m: agg5m,
    agg_1d: agg1d,
  };
  for (const t of TABLES) {
    if (!selected.includes(t) || cancelled) continue;
    await runners[t]();
  }

  // ── reconcile ────────────────────────────────────────────────────────────────
  // Completeness is judged from the per-shard checkpoints, NOT count parity: the live
  // pipeline independently inflates the PG counts (false ✓), and sessions legitimately has
  // fewer PG rows than Turso because PG's (system_id,created_at) unique collapses Turso's
  // duplicate (systemId,started) sessions (false ⚠️). Counts are shown for information only.
  async function tableComplete(name: TableName): Promise<boolean> {
    const meta = await loadShard(`${name}#meta`);
    const n = (meta.cursor as any)?.nShards;
    if (!n) return false;
    for (let i = 0; i < n; i++)
      if (!(await loadShard(`${name}#${i}`)).done) return false;
    return true;
  }
  logAbove("─".repeat(80));
  logAbove(
    "Reconcile (backfill completeness from checkpoints; counts are informational):",
  );
  const checks: [TableName, () => Promise<number>, () => Promise<number>][] = [
    [
      "sessions",
      () =>
        tursoCount(turso.select({ c: sql<number>`count(*)` }).from(tSessions)),
      () => pgCount("sessions"),
    ],
    [
      "point_readings",
      () => tursoCount(turso.select({ c: sql<number>`count(*)` }).from(tPR)),
      () => pgCount("point_readings"),
    ],
    [
      "agg_5m",
      () => tursoCount(turso.select({ c: sql<number>`count(*)` }).from(tA5)),
      () => pgCount("point_readings_agg_5m"),
    ],
    [
      "agg_1d",
      () => tursoCount(turso.select({ c: sql<number>`count(*)` }).from(tA1)),
      () => pgCount("point_readings_agg_1d"),
    ],
  ];
  for (const [n, tc, pc] of checks) {
    if (!selected.includes(n)) continue;
    const [tn, pn, complete] = [await tc(), await pc(), await tableComplete(n)];
    const note =
      n === "sessions"
        ? "  (pg ≤ turso expected: dup (systemId,started) collapse)"
        : "";
    logAbove(
      `  ${complete ? "✓ complete  " : "○ incomplete"} ${n.padEnd(14)} turso=${fmtInt(tn)}  postgres=${fmtInt(pn)}${note}`,
    );
  }
  logAbove("─".repeat(80));
  if (process.stdin.isTTY && apply) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stdout.write("\n");
    console.error("Backfill failed:", err);
    console.error(
      "Re-run the same command to resume from per-shard checkpoints.",
    );
    process.exit(1);
  });
