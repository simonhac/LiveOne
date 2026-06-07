# Engine / Web separation + the ingest durability model

**Status: direction of travel (not yet built).** This is the intended architecture that the
Turso→Postgres migration is the enabler for. The canonical migration status/plan lives in
[`../turso-pg-migration.md`](../turso-pg-migration.md); this doc owns the **target shape** (the
engine/web split and its boundary contracts) and the **ingest durability decision** (how observations
reach the stores). Locked decisions (F) Turso-as-backup and (G) engine/web-split are recorded in the
migration doc; this doc expands them.

---

## 1. Why split the engine from the web

Separate the data-collection **ENGINE** from the **WEB/FE** so the front-end can iterate freely (and
**multiple FEs** can run) without ever risking data collection. Postgres is what makes the boundary
clean: the web reads only Postgres + KV; the engine owns all writes.

**Two runtime roles, split by data-flow:**

- **ENGINE = write/collect.** Cron scheduler → vendor adapters → collector → writes the store + KV +
  publishes to the QStash queue, **plus the QStash observations receiver** (writes PG). Must never be
  disturbed by an FE deploy.
- **WEB (×N) = read/serve.** FE pages + read-only API + Clerk auth + low-frequency config/admin writes.

## 2. The only things that cross the boundary (the contracts)

1. The shared **Postgres** store.
2. The **KV** latest-values cache (engine writes, web reads — engine is the **sole** KV writer).
3. The **QStash** observations queue (engine → receiver).
4. An engine **Control API** + a job queue for web→engine commands (below).

No shared process, no shared in-memory cache, no synchronous web→engine call except the Control API.
Turso is **not** a contract — it's an engine-internal, disposable backup (see §6).

## 3. FE→engine command pattern — "web brokers, engine executes"

The browser never talks to the engine. The web server (which holds the Clerk session) performs the
user's authorization, then re-auths to the engine with a service credential. Two lanes:

- **Sync (request/response)** — interactive config needing the engine's vendor-adapter code: test
  connection, discover monitoring points, validate credentials, "poll now & show the result."
- **Async (durable job)** — long / fire-and-forget: poll-now batch, recompute, resync. The Control API
  enqueues a job (a `jobs` row in PG, or QStash) and returns a job id; the engine worker executes and
  writes status back (job row / KV) for the FE to poll.

Config **persistence** writes the authoritative store (PG); the engine reads it fresh. **Credentials
stay in Clerk** (decision 2026-06-06) — the engine keeps a Clerk read path for vendor secrets
(`lib/secure-credentials.ts` `getSystemCredentials`) and the connect/disconnect OAuth flows write
Clerk; this is **not** moved to PG. Net: the engine exposes exactly two inbound contracts — the
**QStash receiver** and the **Control API**.

## 4. Hard decouplings to do first (code, not deploy — all behaviour-preserving)

1. **Split `lib/api-auth.ts`** into Clerk-auth (web) vs secret/signature-auth (engine) — the QStash
   receiver already uses signature auth. _(Vendor-creds-off-Clerk was considered and **dropped** —
   creds stay in Clerk. `SystemsManager.getSystemByUsernameAndAlias`'s `clerkClient()` username→owner
   lookup is a web-only concern — keep it out of the engine.)_
2. **Extract `pollAllSystems()` / daily aggregation / the receiver handler** out of `NextRequest`/SSE
   route handlers into host-agnostic `async` functions (so they run under a Next route _or_ a worker).
3. **Stop assuming cross-service cache coherence** — `SystemsManager`/`PointManager` 60s caches and the
   `global`-memoised DB pools are fine per-process; the store is the source of truth.

## 5. Deployment shape

Monorepo → `packages/core` (db clients, schema, aggregation math, identifiers, date-utils, observation
types, routing flags) + `apps/engine` (crons + receiver + Control API; a stable public domain e.g.
`engine.liveone.energy`; co-located with PG) + `apps/web` (×N; no crons/receiver/data-writes). Likely
two Vercel projects from one repo (keeps the cron/serverless model); engine-as-worker (Fly/Railway) is
a later option if serverless limits bite. The `OBSERVATIONS_QSTASH_RECEIVER_URL` override already
supports re-pointing the receiver to the engine domain. **Sequence the deploy split AFTER the store is
on PG** — the decouplings above land incrementally now; the split is then mechanical.

---

## 6. The ingest durability model — "should the queue be the only write path?"

**Decision (2026-06-08): adopt the _spirit_, reframe the _letter_.**

> "Collection never synchronously couples itself to the **serving** store; there is exactly **one
> idempotent ingest contract per store**, and its on-ramp is a **durable outbox**." ✅ adopt.
>
> "The queue is the **sole write path** and we **never** direct-insert into any database." ❌ reject as
> literally stated — it conflates a decoupling _transport_ with a durable _log_, and it deletes the only
> thing that currently guarantees a reading survives.

This was assessed by a multi-agent review grounded in the code; all load-bearing claims verified.

### 6.1 What's right (and already ~80% built)

Postgres readings/sessions are written in **exactly one place** — the QStash receiver
(`app/api/observations/receive/route.ts`, all inserts in one session-first transaction). The poller is
topology-blind to PG for readings. So "one idempotent ingest contract into PG" already exists, and the
Turso→PG migration is the living proof of the payoff: PG was bootstrapped by **pointing the existing
receiver at it**. Moving stores, teeing to a Sydney replica / analytics sink, or relocating the receiver
across the engine/web boundary all reduce to "stand up another idempotent consumer." **Lock this in.**

### 6.2 Why "queue = sole write path" is wrong as stated

- **A queue is not a log.** The goals that motivate the position — _rebuild a fresh DB_, _tee-off and
  let a new sink catch up_, _survive infra changes without loss_ — all need a **retained, replayable
  log** (read from offset 0, fan out, backfill). **QStash is not that**: it's an at-least-once HTTP task
  dispatcher (POST-with-retries → DLQ), ~1 MB messages, ~7-day retention, no seek/replay. Once a message
  is acked, it's gone. The DLQ `retry-all` only re-pushes _stranded_ messages within retention; it can't
  reconstruct never-enqueued data. **Tell:** PG holes heal today by copying from **Turso** (a retained
  store) via `scripts/gap-map-raw-readings.ts`, never by replaying the queue.
- **"Never direct-insert" deletes the durability anchor.** The inline Turso write is the one
  must-succeed step (`lib/point/point-manager.ts` raw insert is awaited, uncaught → a failure aborts the
  poll). The enqueue is fire-and-forget: `lib/observations/publisher.ts:139-145` and the session-close
  publish (`lib/session-manager.ts`) both `catch` and only `console.error`. **A swallowed enqueue is a
  permanently lost reading.** The PollCollector also buffers in memory and publishes once at session
  close — a crash mid-poll loses the whole poll from the queue's view.
- **This is the dual-write problem**, and no queue solves it — nothing can deliver a message that was
  never enqueued.

### 6.3 The fix: a transactional outbox (and why a DB write is unavoidable)

In one local transaction, commit the observation **and** an outbox row; a **relay** drains the outbox to
the queue with at-least-once + ack, marking rows published. An outbox **requires a durable local write
first** — so "never touch a database" is self-contradictory. A synchronous first-write to _some_ durable
thing (a store or a real log) is unavoidable; the decoupling is between collection and the **serving**
store, not between collection and **all** durability.

### 6.4 Recommended target for LiveOne

1. **Make Postgres itself the outbox** (post-migration). The poll does
   `BEGIN; insert point_readings; insert observations_outbox; COMMIT;` — one local, coordinated
   transaction. This is a deliberate direct DB write, and it's the boring correct answer.
2. A **relay** drains the outbox → QStash → the existing idempotent receiver (and any tee'd consumer).
   The enqueue is now derived from a committed row and retried until acked — closing the swallowed-
   enqueue and crash-before-publish windows. This **is** the Phase-4 "raw durability off Turso" gate.
3. **Keep the queue as the fan-out / decoupling transport** — its value is real and unchanged. PG (with
   PITR) becomes the replayable source-of-truth; "tee a new sink" = "replay the outbox/PG into it."
4. **Keep Turso until raw-durability-on-PG is proven** (decision F). Turso + `gap-map` is already a
   degenerate outbox (store + relay); we're moving that function into PG, not deleting it.
5. Don't adopt a heavyweight log (Kafka/Kinesis) for one ordered consumer at this volume — a PG outbox
   gives replay/rebuild for free. Keep a real log as a documented escape hatch only if high-volume
   _independent_ consumers ever materialise.

### 6.5 Preconditions before calling the queue the "sole path"

- **Monotonicity guard** on the 5m-native / 1d upserts: today correctness leans on QStash delivery being
  ordered (parallelism = 1) — a broker config, not a data invariant. Add a version/received-time guard
  so a re-delivered or out-of-order **stale** message can never clobber a newer value
  (`lib/db/planetscale/aggregate-points-pg.ts` `previousLast` dependency).
- **DLQ drain/replay tooling** — the `monitor-observations` cron only _alerts_ on DLQ; there's no
  automated drain/replay-from-source.
- **SLOs + paging** on queue lag, DLQ depth, receiver success rate, raw-landing age — and ensure
  `OBSERVATIONS_ALERT_WEBHOOK_URL` is actually set (it's a no-op if unset).
- **Read-after-write**: once Turso reads retire (Phase 2), pure queue→PG ingest adds visibility lag.
  Interactive "poll now & show result" (Control API) needs a synchronous read path or bounded-lag
  acceptance.

### 6.6 Tradeoffs (honest)

Cost is a non-issue (~73K msg/month, well inside $1/100K). The real costs: an outbox + relay is _more_
moving parts than today's swallow-and-heal; parallelism = 1 is a throughput ceiling and a shared failure
line (fine now, a limit if systems scale or you fan out to N consumers); pure queue→PG reads introduce
read-after-write lag. The publish surface is small and centralised (`lib/qstash.ts`,
`lib/observations/publisher.ts`, `poll-collector.ts`, `session-publisher.ts`), so swapping QStash later
is cheap — **provided the durability/replay guarantee lives in the outbox, not in QStash-specific
features.**

---

## 7. Scaling envelope & graduation path

**Baseline (measured 2026-06):** ~1,500 raw rows/hr (~13M/yr; `point_readings` ≈ 13.4M), ~73K QStash
msg/month (~0.03 msg/s avg), 9 systems / 73 points, QStash **parallelism = 1**, serverless receiver,
PlanetScale PG. Two independent growth axes stress different layers: **more sites** (fan-out,
parallelism, connections, config, poller) vs **higher frequency** (row volume, storage, message size,
aggregation).

**Principle:** the _shape_ of §6 (durable capture → decoupled fan-out → idempotent consumers → a
store/log as the replayable source-of-truth) survives at any scale; only the _implementations_ graduate.
**Nothing in the current design is a dead end** — the only dead end would have been making QStash the
system of record (ruled out in §6).

**What breaks first → what you swap (≈ in the order load surfaces it):**

| #   | Bottleneck                                                                                | Swap                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | single-lane queue (`parallelism=1`) caps throughput to ~one receiver round-trip at a time | partition by `systemId` (raise parallelism, per-key ordering); at the top end → a **partitioned log** (Kafka/Kinesis/Redpanda), partition = `systemId` — per-key order + horizontal parallelism + real retention/replay        |
| 2   | serverless receiver + per-invocation PG connections (pool exhaustion, cold starts)        | long-running **batching worker** (engine-as-worker, §5), warm pool, batched `COPY` instead of row-by-row upsert                                                                                                                |
| 3   | single unpartitioned PG time-series table (13B rows/yr at 1000×)                          | **TimescaleDB** (PG extension: hypertables + compression + continuous aggregates that _replace_ the `agg_5m`/`agg_1d` recompute) or **ClickHouse**. NB PlanetScale-PG likely lacks the Timescale extension → a real infra move |
| 4   | deferred agg-recompute cron over billions of rows                                         | **streaming / continuous aggregation** (materialise on ingest)                                                                                                                                                                 |
| 5   | one cron polling all systems                                                              | **sharded / distributed polling**; prefer **push** vendors (Fronius push, Amber) over pull                                                                                                                                     |
| 6   | QStash per-message cost + outbox double-write                                             | **CDC / logical replication** (Debezium on the WAL — the WAL _is_ the outbox, no second write); or the log-backbone (#1) makes the outbox moot                                                                                 |

**Thresholds (don't do it all at once):**

- **~10–50×** — stay on QStash: shard parallelism by `systemId` + native PG monthly **partitioning**. Cheap, no re-platform.
- **~100×** — batching worker (#2) + Timescale/partition+compression (#3) + continuous aggregates (#4).
- **~1000×** (~13B rows/yr, ~28 msg/s avg, peaks higher) — **log backbone** (#1) + time-series store (#3) + poller fleet (#5). At this scale the log-as-backbone you might instinctively reach for today finally pays for itself — it's overkill below it.

The swap surface is small and centralised (`lib/qstash.ts`, `lib/observations/*`, the receiver, the
poller), and the engine/web split (§1–§5) is what lets each be replaced independently without touching
the FE.

---

## 8. Turso status (locked 2026-06-06)

Turso has **no special status** — it is a **transitional best-effort backup of raw `point_readings` +
`sessions` only**, kept solely until PG is fully trusted, then dropped. **Postgres is THE store for
everything** (config, aggregates, raw, sessions). Design as if PG is the only store; the inline Turso
write is an extra best-effort backup deletable with zero architectural change. **Exit condition for
dropping Turso = raw durability on PG** without the inline-Turso safety net — i.e. the outbox of §6.4.
See the migration doc's Phase 4.
