# Postgres connection dropouts in the prod→dev sync workflow

## Summary

Between **2026-07-22 and 2026-07-24**, the `sync-prod-to-dev` GitHub Actions workflow repeatedly
lost its PostgreSQL connection mid-job with `Connection terminated unexpectedly` or
`read ECONNRESET`. Over that window **8 distinct dropout events occurred across 7 of 34 runs**;
**4 of 25 scheduled `main` runs (16%) failed fatally** because of one.

This is a **reliability** incident, not data corruption — no rows were lost or changed. The sync is
idempotent, and the failures either aborted the job cleanly or were recovered by retry.

**The dropouts are not fully root-caused.** The client logs prove only that the TCP/TLS socket
disappeared; they do not identify which party reset it. The best-supported explanation is
**transient server- or intermediary-side resets at the shared PlanetScale Sydney endpoint**
(`aws-ap-southeast-2-1.pg.psdb.cloud`), which both the prod-RO and dev connections traverse.
Confidence: **moderate**. Definitive attribution needs PlanetScale-side server logs.

Assessment of the rate: **elevated but plausible — not clearly abnormal.** PlanetScale explicitly
documents that, without a dedicated PgBouncer, connections are terminated during maintenance,
resize, parameter changes and failover, and that clients _must_ reconnect and retry.

> ⚠️ **This window is a shake-out, not equilibrium.** The COPY engine was rewritten on 2026-07-20
> (`d72a411e`), and the failures cluster on that rewrite and on the config-v4 cutover day
> (2026-07-19 was 11/11 green). Bounded transient-retry (`99b70b51`) landed on **2026-07-25**,
> _after_ every failure recorded here. **Re-measure before drawing conclusions from this document.**

## What Went Wrong

### The three connection legs

One workflow job runs three connection **legs**, all to the same regional gateway (it opens more
than three physical connections — the pooled legs open their own):

| Leg                  | npm script                          | Connection object                                 | Source                          |
| -------------------- | ----------------------------------- | ------------------------------------------------- | ------------------------------- |
| prod→dev COPY        | `db:sync-dev-db`                    | **2× persistent `pg.Client`** (one prod, one dev) | `lib/readings/prod-dev-sync.ts` |
| run-period recompute | `db:recompute-dev-runs`             | **`pg.Pool`** (Drizzle)                           | `lib/db/planetscale/index.ts`   |
| KV rebuild / reown   | `db:rebuild-dev-kv`, `db:reown-dev` | pool / ad-hoc                                     | —                               |

Dropouts hit **all three**, and both endpoints (prod **4**, dev **4**) — which is why a single-leg
explanation does not fit.

### Structural exposure

Three properties of the connection setup make a transient reset both **likely to land** and
**invisible until the next query**:

1. **No TCP keepalive anywhere.** `pg` sets `keepAlive: false` by default and neither `makeClient`
   (`lib/readings/prod-dev-sync.ts`) nor `getPoolConfig` (`lib/db/planetscale/index.ts:37-64`)
   enables it. Long-idle cross-Pacific sockets get no liveness probes, so an intermediary's
   idle-eviction only surfaces on the next query.
2. **Long-lived, frequently-idle clients.** The COPY engine holds _two_ persistent clients for the
   whole run across **18 tables** serially. The **prod** client is idle during every dev-side upsert
   (notably the heavy `point_readings` write) and vice-versa.
3. **The sync runs on a US runner.** `.github/workflows/sync-prod-to-dev.yml:21` is
   `runs-on: ubuntu-latest`, so those persistent connections cross the Pacific for the whole run.

### Why the ~4-second recompute deaths are _not_ a timeout

Three failures died ~4 s into the recompute step, which looks like a fixed statement timeout. It is
not:

- **No `statement_timeout`, `idle_in_transaction_session_timeout`, or `query_timeout` is set
  anywhere** in the codebase. The only timeouts are the pool's `idleTimeoutMillis: 30000` and
  `connectionTimeoutMillis: 10000`.
- **Healthy recompute steps run 5–9 s** — _longer_ than the ~4 s failure point. A fixed timeout would
  have killed the successful runs too.

The errors are socket-layer, carry **no SQLSTATE and no SQL error**, and the same code succeeds on
adjacent runs — so a deterministic query bug is also excluded.

### Why this stayed noisy longer than it should have

- On `main` at the failure SHAs, the recompute leg had **no error listener and no retry**, so a
  single transient drop became an unhandled `'error'` event that crashed Node (`node:events:502`).
- Retries, once added, **restart the entire sync from table 1** and the workflow still goes green —
  so a recovered run reports success while masking the underlying drop. `SYNC_CONNECTION_DROPOUT_COUNT`
  (`scripts/utils/run-workflow-step-with-diagnostics.ts`) is the only signal that it happened.

## Detection

Observed by the user as an unexpectedly high rate of failed/retried `sync-prod-to-dev` runs. The
workflow's own Slack alerting (`Alert on failure`, plus the "recovered from N dropout(s)" note)
surfaced both the hard failures and the recovered ones.

## Incident table

**8 distinct dropout events across 7 runs.** All UTC (AEST = UTC+10). Every endpoint is on the shared
Sydney gateway `aws-ap-southeast-2-1.pg.psdb.cloud`.

| #   | Dropout (UTC)  | Run                                                                         | Outcome     | Trigger / branch          | Leg → endpoint              | Signature                                                      | Elapsed    | Last good op                              | Recovered?                           |
| --- | -------------- | --------------------------------------------------------------------------- | ----------- | ------------------------- | --------------------------- | -------------------------------------------------------------- | ---------- | ----------------------------------------- | ------------------------------------ |
| 1   | 07-22 17:49:54 | [29943526585](https://github.com/simonhac/LiveOne/actions/runs/29943526585) | **fail**    | schedule / main           | COPY → **dev**              | `Connection terminated unexpectedly`                           | **~277 s** | connect banner only; no table line        | No                                   |
| 2   | 07-23 06:44:02 | [29985818392](https://github.com/simonhac/LiveOne/actions/runs/29985818392) | **fail**    | schedule / main           | COPY → **prod**             | `read ECONNRESET` (`errno -104`, `TLSWrap.onStreamRead`)       | ~2.6 s     | none — before first table                 | No                                   |
| 3   | 07-23 10:38:42 | [29999874807](https://github.com/simonhac/LiveOne/actions/runs/29999874807) | **fail**    | schedule / main           | recompute → **dev**         | `Connection terminated unexpectedly` (unhandled `'error'`)     | ~4.2 s     | `Recomputing … last 7d` (sync OK, 25.4 s) | No                                   |
| 4   | 07-24 21:33:52 | [30127971532](https://github.com/simonhac/LiveOne/actions/runs/30127971532) | **fail**    | schedule / main           | recompute → **dev**         | `Connection terminated unexpectedly`                           | ~4.3 s     | `Recomputing … last 7d` (sync OK, 22.7 s) | No                                   |
| 5   | 07-24 22:57:39 | [30132307038](https://github.com/simonhac/LiveOne/actions/runs/30132307038) | **fail**    | dispatch / drain-readings | recompute → **dev**         | `Connection terminated unexpectedly`                           | ~3.95 s    | `Recomputing … last 7d` (sync OK, 20.2 s) | No                                   |
| 6   | 07-24 23:24:39 | [30133471104](https://github.com/simonhac/LiveOne/actions/runs/30133471104) | **fail**    | dispatch / drain-readings | COPY → **prod**             | `Connection terminated unexpectedly`                           | ~2.15 s    | none — before first table                 | No                                   |
| 7   | 07-24 23:42:51 | [30134371479](https://github.com/simonhac/LiveOne/actions/runs/30134371479) | **success** | dispatch / drain-readings | COPY → **prod** (attempt 1) | `Connection terminated unexpectedly` → `attempt 2/3 in 500ms`  | ~2.6 s     | none — before first table                 | **Yes**                              |
| 8   | 07-24 23:42:54 | [30134371479](https://github.com/simonhac/LiveOne/actions/runs/30134371479) | **success** | dispatch / drain-readings | COPY → **prod** (attempt 2) | `Connection terminated unexpectedly` → `attempt 3/3 in 1000ms` | ~2.6 s     | none — before first table                 | **Yes** — attempt 3 synced in 19.0 s |

**Endpoint split:** prod **4** (#2, #6, #7, #8) · dev **4** (#1, #3, #4, #5).

### Failures that are NOT dropouts (excluded from the numerator)

- [30131698146](https://github.com/simonhac/LiveOne/actions/runs/30131698146) (07-24 22:44) —
  `duplicate key value violates unique constraint "area_bindings_slot_priority_unique"` →
  **data/constraint error**, after 9 tables copied cleanly.
- [30132119451](https://github.com/simonhac/LiveOne/actions/runs/30132119451) (07-24 22:53) —
  `prod/dev schema mismatch for sync manifest` on `dashboards` column drift → **schema-parity guard
  abort** (the guard working as designed).

## Frequency analysis

**Window:** 2026-07-22 03:50 UTC → 2026-07-24 23:45 UTC (~2.83 days). **34 runs examined.**

| Split                      | Count                                                 |
| -------------------------- | ----------------------------------------------------- |
| By trigger                 | schedule **25** · workflow_dispatch **9**             |
| By conclusion              | success **26** · failure **8** · cancelled **0**      |
| By branch                  | main **26** · `simonhac/drain-readings-scripts` **8** |
| Failures that are dropouts | **6 of 8**                                            |

| Cohort                                     | Runs | With ≥1 dropout | Rate                                         |
| ------------------------------------------ | ---- | --------------- | -------------------------------------------- |
| **Scheduled `main`** (prod-representative) | 25   | 4               | **16%**                                      |
| Manual dispatch, hardening branch          | 8    | 3               | 38% _(iteration burst — not representative)_ |
| Manual dispatch, `main`                    | 1    | 0               | 0%                                           |
| All runs                                   | 34   | 7               | **20.6%**                                    |

**By leg** (share of the 8 events): prod COPY **50%** · recompute-dev **37.5%** · dev COPY **12.5%**.

**Per connection attempt:** ~3 relevant connections per run × 34 runs ≈ 100 establishments vs 8
events ≈ **single-digit % per connection** (approximate — connection establishments are not logged).

**By failure class** (all 8 failures): transport dropout **6** · data/constraint **1** ·
schema-parity **1** · timeout/cancelled **0** · auth/setup **0**.

## Timeline and clustering (UTC)

- **Cron:** `20 */2 * * *` — every 2 h at nominal minute **:20**. GitHub delivered runs **6–116 min
  late** (median ~70 min) and dropped ~3 of 12 nominal slots/day.
- **Concurrency:** `group: sync-prod-to-dev` — a **static string with no `${{ github.ref }}`** — and
  `cancel-in-progress: false`. All runs share **one global queue across branches**; they queue, never
  cancel.

Events:

- **07-22 17:49** — isolated dropout (dev dest; the anomalous ~277 s long-runner).
- **07-23 06:44 & 10:38** — **two consecutive scheduled slots** both dropped (prod, then
  recompute-dev). The 03:48 slot before and 14:35 after succeeded.
- **07-24 21:33** — scheduled dropout (recompute-dev), then a **manual iteration burst 22:41–23:45**
  on the hardening branch mixing dropouts, the constraint failure and the schema-parity abort.

**Serialization note:** run 30133471104 (#6) was created 23:19:22 while scheduled run 30133418187 was
still in flight (23:18:05→23:21:49), so under the shared concurrency group it **queued and started
immediately after** that run completed, then dropped ~3 min in. The API reports `startedAt ==
createdAt`, so queue-wait cannot be measured directly.

**"2-hour boundary" clustering: not supported.** Failing runs land at ordinary delayed-cron minutes
(17:49, 06:44, 10:38, 21:33) with no alignment to :20 and no shared minute-of-hour.

**Longer context:** this workflow has a pre-existing instability history (failure block 07-12→07-15,
cancelled/timeout block 07-15→07-18, mixed 07-20→07-21) — a continuation of a prior pattern, not a
regression introduced by the hardening branch.

## Hypothesis matrix

| Hypothesis                                                                                | Supporting                                                                                                                                                                                                                                                     | Contradicting                                                                                                                                                                                                                         | Confidence                                                        | Next check                                                                |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **PlanetScale gateway/cluster transient reset** (restart, resize, failover, param change) | Hits **both** endpoints on the **same host**; spans both triggers and both branches over 3 days; PlanetScale documents exactly this and mandates client retry; **no dedicated PgBouncer** in use                                                               | No PlanetScale incident tagged ap-southeast-2 in the window (only unrelated Query-Insights blips); no server-side visibility                                                                                                          | **Leading (moderate)**                                            | PlanetScale cluster events / audit / server logs at the 8 timestamps      |
| **Direct PG interruption (5432)**                                                         | **Measured: no pooler detected on the dev cluster** (equal ports — positive proof only on a mismatch); PlanetScale docs say direct connections are terminated on restart/failover while PgBouncer clients are maintained; recompute deaths are mid-transaction | Prod-leg port still unmeasured                                                                                                                                                                                                        | **Raised — now co-leading**                                       | Measure the prod-leg port on the next run; evaluate 6432/dedicated pooler |
| **PgBouncer idle-reap (6432)**                                                            | 6432 pooler is PlanetScale's recommended app path; local-pooler restarts terminate clients                                                                                                                                                                     | **Measured: no pooler detected on the dev cluster**; documented default `client_idle_timeout = 0` means it wouldn't reap idle clients anyway; #2/#6/#7/#8 drop ~2.6 s after connect                                                   | **Excluded for the dev leg** (3 of 8 events); unmeasured for prod | Measure the prod-leg port                                                 |
| **GitHub Actions runner / network instability**                                           | Published Actions incidents on **all three** dates (07-22 19:36–22:04, 07-23 07:53–09:39, 07-24 16:17–17:36); sync runs on a **US** runner                                                                                                                     | Dropout timestamps mostly fall **outside** those windows (06:44 is ~1 h before the 07-23 incident; 21:33 after all of them); incidents describe _job-start latency_, not egress resets                                                | **Possible aggravator, temporally loose**                         | Finer GH runner/egress feed; move runner to Sydney and re-measure         |
| **TLS/socket config (no keepalive)**                                                      | `pg` keepAlive off by default (source-confirmed) — no probes on idle sockets                                                                                                                                                                                   | Doesn't _cause_ a reset; explains why it's undetected. The ~2.6 s post-connect drops are too fast for idle-eviction                                                                                                                   | **Contributory, not root**                                        | A/B with `keepAlive: true`                                                |
| **Connection-limit pressure**                                                             | Pool `max` 10; serialized back-to-back runs                                                                                                                                                                                                                    | Only 2 clients + a small pool in one job; no `53300` / `too many connections` in logs                                                                                                                                                 | Low                                                               | PlanetScale connection-count metrics at failure times                     |
| **Statement / txn / idle-in-txn timeout**                                                 | ~4 s recompute clustering                                                                                                                                                                                                                                      | **No such timeout configured anywhere — now confirmed SERVER-side too** (`statement_timeout`, `idle_in_transaction_session_timeout`, `idle_session_timeout` all `0`); healthy recomputes run **5–9 s**, longer than the failure point | **Excluded (fully)**                                              | — (code + server verified)                                                |
| **Deterministic query bug as transport error**                                            | ~4 s clustering                                                                                                                                                                                                                                                | Socket-layer errors, **no SQLSTATE**; same code succeeds adjacent; idempotent retry recovers                                                                                                                                          | **Excluded**                                                      | —                                                                         |
| **App misuse of `pg.Client`/`Pool`**                                                      | `main` recompute crashed on unhandled `'error'`                                                                                                                                                                                                                | A _resilience gap_, not the initiating reset; drop originates off-box                                                                                                                                                                 | **Excluded as cause; gap real**                                   | Ensure hardening merged to `main`                                         |

## Connection-path assessment

**Known:**

- Both prod-RO and dev connections resolve to the **same shared Sydney gateway host**. PlanetScale
  co-locates every branch in a region on one host and distinguishes them by **username**
  (`postgres.<branch-id>`) — see `connectionIdentity` in `lib/db/planetscale/index.ts`.
- The dev role carries **no `|replica` and no `|<bouncer-name>` suffix**, so these connections use
  **no read replica and no _dedicated_ PgBouncer** — they do not get the "connections persist through
  failover" guarantee a dedicated pooler provides.
- **No app-level timeouts**; pool `max 10`, `idleTimeoutMillis 30000`, `connectionTimeoutMillis
10000`; **no keepAlive**; TLS is `{ rejectUnauthorized: false }` with URL ssl params stripped.

**Measured 2026-07-25.** Provenance matters here: this was `logConnectionPath()` run **locally**
against the `liveone-dev` cluster via `PLANETSCALE_DATABASE_URL`. It is **not** a CI measurement of
the sync's own credentials — `LIVEONE_DEV_DATABASE_URL` and `PG_PROD_RO_DATABASE_URL` are
GitHub-only secrets and remain unmeasured until the next scheduled run.

```text
clientPort 5432 · serverPort 5432 · portMismatch false · verdict "inconclusive"
statementLimit 0 · idleTxnLimit 0 · idleSessionLimit 0
keepalivesIdle 7200 · serverVersion 17.10
```

(The four settings are PG's `statement_timeout`, `idle_in_transaction_session_timeout`,
`idle_session_timeout` and `tcp_keepalives_idle`; the field names avoid the literal word "timeout"
so they can't trip the workflow's failure classifier.)

Three conclusions:

1. **No pooler was detected on the dev cluster — but "not detected" is weaker than "absent".**
   `inet_server_port()` reports only the LAST hop, so a port **mismatch** is positive proof of
   re-origination while equality proves nothing: a transparent same-port proxy is invisible to this
   test. Hence the probe reports `inconclusive`, never `direct`. Taken with PlanetScale's
   documented split (6432 = PgBouncer, 5432 = direct), the likeliest reading is that we are on the
   direct path — the configuration their docs warn about: _"if you cannot use a dedicated PgBouncer
   … you will see errors during failovers"_, whereas _"when using PgBouncer, client connections are
   maintained."_
2. **No server-side timeout of any kind.** The earlier exclusion of a fixed ~4 s timeout rested on
   _client_ config alone — a role-level `ALTER ROLE … SET statement_timeout` would have been
   invisible to it. All three read `0`. The timeout hypothesis is now **fully excluded**, not merely
   argued. (This conclusion is cluster-wide, so it holds regardless of which credential CI uses.)
3. **Neither end probes a dead socket.** The client sets no keepalive at all, and the server only
   begins probing after `tcp_keepalives_idle = 7200` (2 hours) — far beyond any ~20–30 s sync. A
   silently-dropped connection is therefore undetectable until the next query, which is exactly the
   observed symptom.

**Still unknown:**

- The ports of **`PG_PROD_RO_DATABASE_URL`** (prod read-only, 4 of the 8 events) **and
  `LIVEONE_DEV_DATABASE_URL`** (the sync's own dev write credential). Both are GitHub-only secrets;
  the instrumentation records both on the next scheduled run.
- Whether a **dedicated PgBouncer** is available for this cluster.

## Considered and rejected: restructuring `liveone-dev` as a branch of prod

A natural response to "the sync keeps dropping" is "stop syncing — make dev a **branch** of the prod
`liveone`/`sydney` database." This was researched and **rejected**. Two independent adversarial
reviews (one briefed to attack the status quo, one to defend it) converged on _do not migrate_.

### Billing model

You pay **per branch, because each branch _is_ its own cluster**. A _database_ is a free namespace;
the branch/cluster is the line item (instance size + disk + backups + egress + replicas).

> "Each branch runs on its own dedicated cluster and is billed separately based on its configuration
> and usage." — [PlanetScale pricing](https://planetscale.com/docs/postgres/pricing)

Branches are **not** copy-on-write: _"Each branch is its own isolated database and uses its own
storage separate from production. … There is no data replication between branches."_

**Cost is therefore a wash** — no branch discount, no shared storage. Current state: prod `sydney` is
PS-5 ARM with 2 replicas (HA) ≈ **$15/mo**; `liveone-dev` is PS-5 ARM single-node ≈ **$5/mo**. Data
is 5.3 GB, under the 10 GB free-per-cluster disk allowance, so storage is $0 either way (crossing it
in ~8–9 months at ~0.5–0.6 GB/mo; Sydney storage is $0.150/GB/mo).

### Why branching loses

1. **Identity-rotation tax (decisive).** There is no data replication and **no in-place branch
   refresh** — the documented lifecycle is create → use → **delete**. Staying fresh means re-forking,
   and each re-fork mints a new `branch_id` → new username (`{role}.{branch_id}`) → rotate 1Password
   (11 `op://liveone-dev/env/*` refs), **22 Conductor worktrees'** `.env.local`, Vercel **Development
   _and_ Preview** scopes, the `LIVEONE_DEV_DATABASE_URL` GitHub secret, **plus a redeploy** (Vercel
   captures env at build time). Today's reseed is a `pg_restore` **into the same branch** — the
   connection identity never changes.
2. **A branch does not delete the sync.** A seeded branch is a point-in-time snapshot that goes stale
   immediately. Crons are off in dev, so dev generates nothing — a frozen fork simply rots.
3. **It removes the only unattended schema-drift canary** — `assertManifestSchemaParity`
   (`assertManifestSchemaParity`, `lib/readings/prod-dev-sync.ts`) compares columns, constraints and
   indexes across the manifest's 18, 12×/day. This repo's worst outage
   ([2026-06-16](2026-06-16-prod-down-default-dashboard-migration-not-applied.md), 5h50m) was exactly
   prod/dev migration drift.
4. **DB-level settings become shared** with prod (IP restrictions, PITR schedule, deletion
   protection, default branch), and deleting a database removes _all_ its branches and backups
   permanently.
5. **Savings were overstated.** Truly deletable code under a fork model is **~1,100–1,300 LOC**, not
   the ~2,700 first estimated — `reown-dev-data.ts` (separate Clerk instance),
   `rebuild-dev-kv-from-db.ts` (crons off) and `recompute-dev-runs-from-db.ts` survive under _every_
   option.

**Also rejected:** Supabase for dev (new branches start with no data — rebuilds the same machinery);
Neon for dev only (real copy-on-write and scale-to-zero, but only pays off with per-PR ephemeral DBs,
which needs KV branch-namespacing plus inverting `preview-alias.yml`, and forfeits prod-engine
fidelity); per-PR PlanetScale branches (seeding up to 12 h stale).

**Revisit only if** PlanetScale ships in-place branch reset or stable per-branch credentials, **or**
cross-database backup restore into `liveone-dev` is confirmed possible (see Action Items).

## Resolution

**Partial — mitigated, not root-caused.** Hardening landed on `simonhac/drain-readings-scripts`
(PR [#236](https://github.com/simonhac/LiveOne/pull/236), merged `99b70b51`, 2026-07-25):

1. **`lib/db/planetscale/transient-retry.ts`** — classifies transient failures (SQLSTATE `08*`,
   `57P01/02/03`, `ECONNRESET`/`EPIPE`/`ETIMEDOUT`/…, and the `connection terminated` /
   `socket hang up` / `broken pipe` message forms, recursing into `error.cause`) and retries with
   **3 attempts, linear backoff** (500 ms → 1000 ms).
2. **Whole-sync retry** — `scripts/utils/sync-prod-to-dev-db.ts` wraps the entire idempotent sync,
   restarting from table 1 on a transient drop.
3. **Per-client error listeners** — `pool.on("connect", client => client.on("error", …))`
   (the `pool.on("connect")` handler in `lib/db/planetscale/index.ts`) stops a drop on a _checked-out_
   client (mid-transaction)
   from crashing Node before retry code can see it.
4. **Immutable point resolution moved outside the transaction** (`run-periods-pg.ts:76-83`) so the
   transaction no longer idles while a second pooled connection does a lookup.
5. **Diagnostics** — `run-workflow-step-with-diagnostics.ts` classifies failures and counts
   _recovered_ dropouts into `SYNC_CONNECTION_DROPOUT_COUNT` for Slack.

**A successful retry proves the operation is idempotent and resilient. It does not prove the dropout
rate is acceptable, and it does not address the initiating cause.**

## Lessons Learned

1. **Retries mask rate.** Once the whole sync retries, a run goes green while still dropping
   connections. Without `SYNC_CONNECTION_DROPOUT_COUNT` the true rate is invisible. Always emit a
   recovered-failure counter, not just pass/fail.
2. **Don't treat every failed workflow as the same failure.** Of 8 failures, only 6 were transport
   dropouts; 1 was a constraint violation and 1 was the schema-parity guard doing its job. Counting
   them together would have inflated the rate by a third and pointed at the wrong cause.
3. **A shake-out window is not an equilibrium.** The rate was measured across a ~2.83-day window inside the 5 days in which the
   COPY engine was rewritten and config-v4 cut over. 07-19 was 11/11 green.
4. **Symptom location ≠ fault location.** Drops hit prod reads, dev writes and the recompute pool —
   the shared regional endpoint and the cross-Pacific network path, not any one leg.
5. **Absent config is evidence.** Confirming that _no_ `statement_timeout` exists is what excluded
   the most seductive hypothesis (a fixed ~4 s timeout).
6. **Check where the code runs, not just what it does.** The single cheapest lever found — a US
   runner holding persistent connections to Sydney — is one line of workflow YAML, and no amount of
   database restructuring would have addressed it.
7. **Verify "live proof" before repeating it.** An empty, single-node branch created during the
   investigation was cited as evidence that branches inherit prod's HA topology (and cost 3×). It was
   `replicas=0` and `restored_from=null`. The adversarial pass caught it; the claim was false.

## Action Items

Ordered by diagnostic value ÷ risk. Items 1–4 are independent of the dropout root cause and worth
doing regardless.

- [ ] **0. BURN-IN (agreed 2026-07-25 — this is the active plan).** Change nothing else for **two
      days**; re-assess on/after **2026-07-27**. `withTransientPostgresRetry` (`99b70b51`) and the
      forensics instrumentation both landed _after_ every failure recorded here, so the existing
      numbers describe a system that no longer exists. At the 2-hourly cron that's ~24 scheduled
      runs — enough to separate "shake-out" from "equilibrium".

      **Re-assess with:** the appendix counts (dropout events ÷ scheduled `main` runs), plus the
      two new signals — the `conn-path` verdict for the **prod** leg (still unmeasured), and the
      `shape`/`phase` of any `socket-death` (FIN vs RST; idle vs mid-stream).

      **Decision rule:**
      - **≥95% green** → mitigation is sufficient; close the incident, leave the topology alone.
      - **Dropouts persist** → proceed to item 1 (Sydney-local runner) as the next change, since
        it is the cheapest test of the leading hypothesis. Items 2–4 are worth doing regardless.

- [ ] **1. Move the sync to a Sydney-local executor.** `.github/workflows/sync-prod-to-dev.yml:21` is
      `runs-on: ubuntu-latest` (US) while the engine holds two persistent connections to Sydney for
      the whole run. Reuse the existing Fly `primary_region = "syd"`
      (`packages/usher/deploy/fly/fly.toml:22`). If dropouts persist afterwards, that cheaply proves
      the cause is PS-5 server-side capacity rather than the Pacific. _(~1 day, low risk, reversible)_
- [ ] **2. Split the manifest: config-sync vs bulk-sync.** Config tables (`systems`, `point_info`,
      `areas`, `area_bindings`, `dashboards` — <1 MB) stay on the 2-hourly schedule over a short
      connection; the bulk readings top-up moves to daily/on-demand. A dropped `point_readings`
      stream then cannot block config freshness — the only freshness config-v4 needs. _(~half a day)_
- [ ] **3. Fix or de-fatalise the `reown` leg.** `ERR: one or more ownership updates failed`
      (duplicate keys on `user_system_unique`, `dashboard_grants_dashboard_user_unique`) was an
      equal-largest failure contributor in a wider sample. It is **topology-independent** and
      survives every option. _(hours)_
- [ ] **4. Trim dev retention** — 90 d `point_readings` + `agg_5m`, 7 d `sessions`; keep 100% of
      `point_readings_agg_1d`, `flow_attr_1d`, `battery_provenance_daily` (the Year view and the
      365-day provenance panel read these, not raw). 5.3 GB → ~1–1.5 GB, shrinking every sync and
      reseed. Verify first that no dev/preview workflow reads raw readings older than 90 days.
- [ ] **5. Enable TCP keepalive** (`keepAlive: true` + a short `keepAliveInitialDelayMillis`) on the
      sync clients and the pool. Now measured to matter: the client sets **no** keepalive and the
      server's `tcp_keepalives_idle` is **7200 s**, so _neither end_ probes a dead socket within a
      ~20–30 s sync — the drop can only be discovered by the next query.
- [x] **6. Log the resolved port** — done (`lib/db/planetscale/connection-forensics.ts`). Result:
      **no pooler detected** on the dev cluster (locally probed). Both CI credentials record on the
      next scheduled run.
- [ ] **6a. Evaluate the 6432 pooler — but ask about a DEDICATED PgBouncer first.** PlanetScale
      documents that direct connections are dropped on restart/failover while PgBouncer clients are
      maintained, and we are on the direct path. Three caveats decide this:

      1. **Local ≠ dedicated.** The benefit that would actually help — connections persisting
         "through cluster resizes, upgrades, and most failover scenarios", and `PAUSE` queueing
         instead of erroring — is attributed to a **dedicated** pooler. A _local_ PgBouncer runs on
         the primary's host node and dies with it, so merely switching the port may buy nothing.
         **Ask PlanetScale whether a dedicated pooler is available on these PS-5 clusters.**
      2. **Bulk work is the category PlanetScale steers away from the pooler** (`pg_dump`/DDL are
         called "incompatible with PgBouncer"; COPY is undocumented). So if trying pooling, move the
         **recompute leg** (a normal Drizzle workload — exactly what 6432 is recommended for; 3 of
         8 events) and leave the **COPY sync leg** direct. Migrations stay on 5432 regardless.
      3. **Compatibility is not the blocker** — the sync was audited and is transaction-pooling
         safe: staging uses real `UNLOGGED` tables in `sync_staging` (not temp); the one
         `CREATE TEMP TABLE _drift` is `ON COMMIT DROP` inside a single `BEGIN…COMMIT` batch;
         `pg_advisory_xact_lock` is transaction-scoped; no `LISTEN`/`NOTIFY`, session-level `SET`,
         or explicit `PREPARE`.

      Note this is a **config change (a port in a secret URL), not code** — cheap and reversible,
      which is why it should follow the burn-in measurement rather than pre-empt it.

- [ ] **7. Operator checks on PlanetScale:** cluster events / audit / server logs at the 8 dropout
      timestamps; connection-count and restart metrics; whether a **dedicated PgBouncer** is
      available (it would make connections survive failover).
- [ ] **8. Ask PlanetScale support one question:** _can a backup of database `liveone` be restored
      into a branch of a different database (`liveone-dev`)?_ If yes, the status quo gains
      branching's only real advantage — an in-region physical reseed with no client connection — for
      free, and the structure question is settled permanently.
- [ ] **9. Add jittered backoff** to the retry, to avoid the retry burst PlanetScale warns about
      during failovers.

### Unrelated findings surfaced during this investigation

- [ ] **Delete `liveone/cutover-rehearse-1`** when the rehearsal is done — an empty, production-class
      cluster billing ~$5/mo on the **prod** database (created 2026-07-25T01:03Z).
- [ ] **Reconcile the pg-backup cadence and check prod egress.** `pg-backup/liveone.yaml` sets
      `staleness.slot-minutes: 480` (8-hourly) while the workflow header **and** `CLAUDE.md` say
      "2-hourly". A full `-Fc` logical dump streams the whole heap off prod each run against a
      100 GB/mo allowance ($0.111/GB Sydney) — **potentially a larger line item than the entire dev
      database.** Read dashboard → Usage → egress for `sydney`.
- [ ] **Scrub branch IDs from the public repo.** Both prod and dev `branch_id`s are in plaintext at
      [`2026-06-16-…md`](2026-06-16-prod-down-default-dashboard-migration-not-applied.md) lines
      69-70. `PLANETSCALE_PROD_BRANCH_ID` is the DB-environment guard token, and project memory
      records `simonhac/LiveOne` as **public**. (Identifiers, not credentials — but they should not
      be tracked.)

## Status

- [x] Dropouts quantified against a denominator (34 runs; 8 events; 16% of scheduled `main`)
- [x] Non-dropout failures separated out (constraint, schema-parity)
- [x] Fixed-timeout and deterministic-query hypotheses excluded
- [x] Mitigated — bounded transient retry, per-client error listeners, diagnostics (`99b70b51`)
- [x] Restructuring `liveone-dev` as a branch evaluated and rejected
- [x] Forensic instrumentation added (`lib/db/planetscale/connection-forensics.ts`) — pooler
      detection, server-side timeout snapshot, FIN-vs-RST socket death reports
- [x] Server-side timeouts ruled out (all `0` — hypothesis fully closed)
- [ ] **Root cause confirmed** — attribution unresolved; needs PlanetScale-side logs
- [~] Connection path — **no pooler detected on the dev cluster (locally probed)**; both CI
  credentials still pending the next scheduled run
- [ ] Post-hardening rate re-measured (Action Item 0)
- [ ] Prevention action items implemented

## Appendix — reproducibility

All counts were produced read-only with `gh` against `simonhac/LiveOne`.

```bash
# Denominator: all runs of the sync workflow in the window
gh run list --repo simonhac/LiveOne --workflow sync-prod-to-dev.yml --limit 200 \
  --json databaseId,event,status,conclusion,headBranch,headSha,createdAt,updatedAt \
  | jq '[.[] | select(.createdAt >= "2026-07-22T00:00:00Z")]
        | {total: length,
           byEvent:      (group_by(.event)      | map({(.[0].event):      length}) | add),
           byConclusion: (group_by(.conclusion) | map({(.[0].conclusion): length}) | add),
           byBranch:     (group_by(.headBranch) | map({(.[0].headBranch): length}) | add)}'

# Per-run metadata + step timings (UTC)
gh run view <id> --repo simonhac/LiveOne \
  --json databaseId,event,conclusion,headBranch,headSha,createdAt,updatedAt,jobs

# Dropout signatures + timestamps (grep — never full-dump; logs are large)
gh run view <id> --repo simonhac/LiveOne --log 2>/dev/null \
  | grep -inE 'Connection terminated unexpectedly|read ECONNRESET|ECONNRESET|EPIPE|socket hang up|Client has encountered a connection error|transient connection failure|attempt [0-9]/[0-9]|✓ Sync complete|✗|exit 1'

# Cluster/branch topology (read-only)
pscale branch list liveone     --format json
pscale branch list liveone-dev --format json
```

**Provider sources consulted:** PlanetScale
[connecting](https://planetscale.com/docs/postgres/connecting) ·
[connection-resilience](https://planetscale.com/docs/postgres/connection-resilience) ·
[pgbouncer](https://planetscale.com/docs/postgres/connecting/pgbouncer) ·
[branching](https://planetscale.com/docs/postgres/branching) ·
[pricing](https://planetscale.com/docs/postgres/pricing);
[node-postgres pool](https://node-postgres.com/apis/pool) /
[client](https://node-postgres.com/apis/client) and `pg` source (`client.js` —
"Connection terminated unexpectedly"; `keepAlive` defaults false);
[Node `ECONNRESET`](https://nodejs.org/docs/latest-v22.x/api/errors.html);
[PostgreSQL SQLSTATE classes 08 / 57](https://www.postgresql.org/docs/current/errcodes-appendix.html);
`planetscalestatus.com` and `githubstatus.com` `/api/v2/incidents.json`.

**Could not be retrieved:** PlanetScale scheduled-maintenance JSON (404); whether COPY is supported
under PlanetScale's transaction-mode pooler (docs silent); the port of each secret URL.

**Key code references:** `lib/readings/prod-dev-sync.ts` (`makeClient`, two persistent clients,
18-table serial loop, `assertManifestSchemaParity`) · `lib/db/planetscale/index.ts` (pool config,
per-client error listener, shared-host note) · `lib/db/planetscale/transient-retry.ts` ·
`lib/db/planetscale/run-periods-pg.ts` · `scripts/utils/run-workflow-step-with-diagnostics.ts` ·
`.github/workflows/sync-prod-to-dev.yml` · `docs/sync-prod-to-dev.md`.
