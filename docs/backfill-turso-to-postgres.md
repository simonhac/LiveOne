# `scripts/backfill-turso-to-postgres.ts`

One-time (re-runnable) tool that copies the full history of **sessions**, **point_readings**,
**point_readings_agg_5m** and **point_readings_agg_1d** from **Turso** (SQLite, source of
truth) into the **Postgres mirror**. It fills everything that predates the live (Phase 1)
QStash pipeline. Turso stays authoritative; Postgres is the secondary mirror.

It is **direct** (Turso → Postgres over a pooled connection), not routed through QStash:
the queue is for live deltas, but a ~17M-row history is faster, cheaper and far more
controllable as a direct streamed copy. See the QStash decision in the project notes.

## Quick start

```bash
# dry run — reports per-table counts + resume state, writes nothing
NODE_ENV=production npx tsx scripts/backfill-turso-to-postgres.ts

# run it (live TUI: [p]ause / [r]esume / [c]ancel), fresh start, with a log to tail
NODE_ENV=production npx tsx scripts/backfill-turso-to-postgres.ts --apply --reset --log=/tmp/backfill.log

# prove nothing was dropped (read-only)
NODE_ENV=production npx tsx scripts/backfill-turso-to-postgres.ts --verify
```

`NODE_ENV=production` points the Turso client at **prod** Turso; omit it to copy a dev
`dev.db` instead. The Postgres target comes from `PLANETSCALE_DATABASE_URL` or the discrete
`DB_*` vars in `.env.local`.

## Flags

| flag             | default       | meaning                                                                            |
| ---------------- | ------------- | ---------------------------------------------------------------------------------- |
| `--apply`        | off (dry run) | actually write to Postgres                                                         |
| `--verify`       | off           | read-only completeness check (see below); ignores `--apply`                        |
| `--reset`        | off           | forget saved checkpoints + pinned geometry for the selected tables and start fresh |
| `--table=<name>` | all           | restrict to one of `sessions` \| `point_readings` \| `agg_5m` \| `agg_1d`          |
| `--shards=N`     | 8             | read-parallelism: how many key-ranges to scan concurrently (per table)             |
| `--writers=N`    | 6             | **max concurrent Postgres writes**, global — the throughput-critical knob          |
| `--limit=N`      | 0 (all)       | stop after ~N rows this run (smoke tests); best-effort, see caveats                |
| `--log=<path>`   | none          | append a chatty, timestamped log (per read/write/retry/checkpoint), `tail -f`-able |

## How it works

- **Sharded parallelism.** Each table's key axis (`id` for sessions/point_readings;
  `interval_end` for agg_5m) is split into `--shards` contiguous ranges, each driven by an
  independent worker that pages through its range (read Turso → upsert Postgres). Workers
  overlap each other's read and write latency, so aggregate throughput ≈ several × a single
  stream, bounded by Postgres capacity.
- **Writer throttle (decoupled from shards).** Concurrent Postgres writes are capped by a
  global semaphore at `--writers` (default 6). This is deliberate and load-bearing: the
  managed Postgres is connection-sensitive, and flooding it with many concurrent writers
  causes connection drops (`57P01`) → a retry/backoff storm that is **far slower** than a
  handful of steady writers (observed: 16 writers ≈ 330 rows/s with a retry storm; 6 writers
  ≈ steady multi-k/s, zero retries). Shards can be high for read-parallelism while writers
  stay low.
- **Pinned geometry → safe resume.** On the first `--apply` run each table records its
  `min/max/nShards` snapshot in a `backfill_progress` row keyed `<table>#meta`. Every resume
  reuses that snapshot, so shard ranges are deterministic even though the live `max` keeps
  growing and even if `--shards` is passed differently. `max` is the snapshot upper bound —
  rows added above it after the snapshot are the live pipeline's job, not the backfill's.
  Changing `--shards` is ignored unless you `--reset`.
- **Resumable + idempotent.** A per-shard checkpoint row (`<table>#<i>`, cursor + rows-done)
  is written after every page, so a crash / `Ctrl-C` re-does at most one page per shard.
  Every write is upsert / do-nothing, so re-runs and overlap with the live pipeline never
  duplicate.
- **Transient-tolerant.** Each write retries (bounded, exponential backoff) on transient
  Postgres errors (`40P01`, `40001`, `57P01`, `08xxx`, `ECONNRESET`, …); the backoff is
  interruptible so `[c]ancel` responds promptly.
- **Live dashboard.** One in-place line per table repaints ~4×/s — `%`, rows, rows/s, ETA,
  and per-shard phase (`reading / writing / done / retries`). Progress advances every write
  chunk (2k rows), never per-whole-page, so it never looks stalled. Off-TTY (piped /
  background) it prints plain headline lines instead of ANSI.

## Per-table specifics

- **sessions** — id preserved as the Postgres PK (then the serial sequence is `setval`'d).
  Written with `onConflictDoNothing` (no target) because Postgres enforces a second unique
  `(system_id, created_at)` that Turso does not, so Turso can hold two sessions sharing it;
  the duplicate collapses to one Postgres row (expected). Turso `started` → Postgres
  `created_at`. **The historical `response` JSONB blob is intentionally dropped (`null`)** —
  it's a large audit payload (~3 KB/row) that dominated session write cost (~30 s per 2k-row
  chunk → ~1.7 s once skipped, ~10× overall); live sessions keep their full `response` via
  the Phase-1 consumer.
- **point_readings** — Postgres keeps its own serial `id`; dedup is on the unique
  `(systemId, pointId, measurementTime)` via `onConflictDoNothing` (raw readings are
  immutable). `createdAt` is set to `received_time` so backfilled rows stay out of the live
  "ingested per minute" dashboard chart and are self-labelling as backfill.
- **agg_5m / agg_1d** — full aggregate tuple, `onConflictDoUpdate` on the PK so it overwrites
  any lossy rows and is re-runnable. `createdAt` carried from the Turso row.

## `--verify` — proof that not a single record was dropped

Read-only. For each table it compares **per-UTC-day bucket counts of the business key**
between Turso and Postgres. Because Postgres only ever holds keys sourced from Turso
(backfill or dual-write), **Postgres ⊆ Turso**, so equal per-bucket counts ⟹ identical key
sets ⟹ zero drops. Bucketing (rather than one grand total) prevents a drop in one region
from being masked by a live-write surplus elsewhere. sessions compares Turso
`COUNT(DISTINCT system_id, started)` against Postgres `COUNT(*)` to account for the
dup-collapse. Today's bucket can legitimately differ by the **live in-flight tail** (rows in
Turso whose queue message Postgres hasn't consumed yet) and is reported separately, never
counted as a drop. Output ends with `✅ VERIFIED — not a single historical record dropped`
or `❌ N historical records missing`.

## Caveats

- **`--shards` is pinned** per table after the first run (`#meta`); re-shard requires `--reset`.
- **`--limit` is best-effort** across shards — it stops at the next page boundary, so it can
  overshoot by up to `~shards × page (10k)` rows. Smoke tests only.
- **sessions `response` is null** for historical rows (see above) — by design.
- **Tuning:** if the dashboard's `retries` counter climbs, you have too many writers — drop
  `--writers`. More `--shards` only helps reads; it won't fix a write bottleneck.

## Reference run (prod, ~13M point_readings + 3.3M agg_5m + 0.75M sessions + 12K agg_1d)

`--shards=8 --writers=6`: sessions 3:07, point_readings 47:12 (~4.6k/s), agg_5m 17:40, agg_1d
0:10 — **~68 min total**, `--verify` clean (zero historical records dropped).
