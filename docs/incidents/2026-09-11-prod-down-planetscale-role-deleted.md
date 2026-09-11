# Prod outage — prod's database role was deleted as if it were a leftover temp role

## Summary

On **2026-09-10 13:59 UTC (23:59 AEST)** the PlanetScale role in Vercel Production's
`PLANETSCALE_DATABASE_URL` was deleted. Every database-touching route in prod 500'd for
**8 h 31 m**, and fleet-wide ingest stopped dead.

Two **independent** faults, and keeping them apart is the point of this report. The first is the
outage; the second is why one site lost ~5 h of data *the first fault had not already cost*, and
would have stayed broken indefinitely.

| | Fault | Effect |
| --- | --- | --- |
| **A** | Prod's durable runtime credential was named `sydney-2026-07-14-depvs9` — indistinguishable from the short-lived `pscale role` temp credentials created for every migration — and was swept up in a cleanup of exactly those | Total prod outage, 8 h 31 m; ~8.5 h ingest gap fleet-wide |
| **B** | The `musher` collector on the flyhub **died 4 h into the outage and did not recover when the receiver came back**. Its sibling `fusher` survived the identical outage | A further 4 h 52 m of Daylesford Generator data never collected; the site was still dead 5 h later, with nothing reporting it |

**A is why prod was down. B is why data was lost that the recovery could not have recovered.**
Fault A's data was largely recoverable — the usher spool and the vendor APIs held it. Fault B's was
not: a collector that has stopped produces nothing to recover.

No data was corrupted. The database was never damaged or at risk — it was **unreachable**, not
broken, and every table was intact and current-to-13:59 when access was restored.

## What Went Wrong

### The trigger

Migration `0063` (`derivation_sources`) was applied to prod that afternoon via `npm run pg-migrate`,
which mints a short-TTL `pscale role`, applies, reassigns ownership and deletes the role. That is
the correct procedure and it worked. It also left the audit log full of correctly-named,
correctly-deleted temp roles:

```
13:58:43  branch_role.created   m20260910135842
13:58:52  branch_role.deleted   m20260910135842
13:59:05  branch_role.deleted   sydney-2026-07-14-depvs9   ← prod's runtime credential
```

The last line is the incident. `sydney-2026-07-14-depvs9` was **the app's permanent credential**,
minted by hand during the recovery from the [2026-06-16 prod
outage](2026-06-16-prod-down-default-dashboard-migration-not-applied.md)-era work on 2026-07-14 and
wired into Vercel Production, where it had served every request for 58 days. Its name says
"scratch role from a migration on a date": the same shape as `m0063-apply`, `own-audit`,
`apply-0062`, `guard-probe` and the two dozen others in the log. In a tidy-up of leftovers it was
the *most* plausible-looking leftover on the list.

The last successful write landed at **13:59:00**; the role was deleted at **13:59:05.543**. There is
no ambiguity about cause.

### Why it presented as a mystery rather than an obvious auth failure

Every fast diagnostic said the database was fine:

- `/api/health` → `{"status":"error","error":"Failed query: SELECT 1"}` — names the symptom, not the
  cause. It cannot distinguish "wrong password", "no such role", "branch asleep" or "network".
- `pscale branch list liveone` → **`state: ready`, `ready: true`**. 🛑 That describes the *branch*,
  and says nothing about whether any credential can authenticate to it.
- The gateway host accepted TCP on 6432 from a laptop.
- The newest Production deployment was `● Ready`, 8 h old, and had been serving fine for hours
  before the outage.
- `pscale role list` showed three healthy-looking roles — and the absence of a fourth is not
  something a human notices unless they know which one to look for.

The branch's `updated_at` was also `2026-09-10T22:04:30Z`, ~20 minutes before the outage was
reported — a red herring, with no corresponding audit-log event, that invited a story about a
PlanetScale-side change.

**The diagnostic that actually settles it in one step:** the role id is embedded in the username.
Pull Production's `PLANETSCALE_DATABASE_URL`, read `pscale_api_<ROLE-ID>.<branch-id>`, and check
`<ROLE-ID>` against `pscale role list liveone sydney`. Absent ⇒ the credential is gone and no amount
of redeploying will help.

### Fault B — one collector died, its sibling did not

The flyhub (`liveone-flyhub`) runs two collectors against one receiver. Both spool undelivered
batches to disk on a **transient** push failure and re-send them idempotently; a receiver outage is
exactly the case that machinery exists for, and for `fusher` it worked perfectly — Kinkora Fronius
recovered **100%** of the gap with no intervention.

`musher` (Daylesford DeepSea) instead stopped. Its blackbox journal ends at **17:58:00Z**, ~4 h into
the outage, with 214 entries for the day against kinkora's 1370. It did not resume when the
receiver returned at 22:30. Five hours later:

- WireGuard: both peers handshaking, `10.0.1.244` answering ICMP with 0% loss — the network was
  never at fault.
- The spool held **46 sheephouse batches, static** — the runbook reads a static spool as "pushes
  rejected (4xx)", which sent the diagnosis briefly down the wrong path. The real reason was that
  nothing was calling drain, because the collector was dead.
- No `[sheephouse]` log lines at all — not even errors. Only kinkora's `stored 13 readings (200)`,
  once a minute, looking perfectly healthy.

A machine restart (generator confirmed idle first) revived it and drained all 46 batches, recovering
13:42–17:58 exactly. **Why `musher` died and `fusher` survived is not yet understood** and is the
most important action item here. `MUSHER_DIAGNOSTICS=1` was on, so the evidence is on the volume.

### The recovery machinery cannot see a fresh gap

`/api/cron/repair-coverage` was the obvious next move and would have been a **no-op that looked like
a fix**. All three providers set `graceDays: 7`, so its gap-find window is `[today−lookback,
today−7]`: the trailing week is deliberately excluded because Amber is still settling. The gap you
have minutes after an outage is precisely the window the self-heal is built not to touch. It will be
swept automatically in ~7 days. This is a gap in tooling, not a defect — now documented in
[outage-catchup.md](../outage-catchup.md).

## Detection

**By a human, looking at the site.** ~8 h 20 m after it started, and ~5 h after `musher` died. There
was no page, no alert and no webhook post for either fault. `OBSERVATIONS_ALERT_WEBHOOK_URL` exists
and `/api/cron/monitor-observations` runs every 15 minutes — worth confirming why neither spoke.

## Resolution

1. Created a durable replacement role (**`--ttl 0`** — the default TTL would have scheduled the next
   outage) and **tested it with `psql` before prod saw it**.
2. Rebuilt the URL on the **pooler port 6432** with `?sslmode=verify-full` — a freshly minted
   `database_url` comes back on **5432**, which is not what prod runs.
3. `vercel env rm/add PLANETSCALE_DATABASE_URL production`, then
   `vercel redeploy <latest-prod-deployment> --target production` — redeploying the **existing**
   deployment, never `vercel --prod` from a feature-branch worktree.
4. Prod healthy at **22:30 UTC**; ingest resumed within a minute; `fusher`'s spool self-drained.
5. Replaced the initial admin-inheriting role with a least-privilege one
   (`pg_read_all_data,pg_write_all_data`), verified across all 25 tables plus `nextval`, advisory
   locks and `FOR UPDATE SKIP LOCKED`, and confirmed by watching a **write** land — not just
   `SELECT 1`. Deleted the interim admin role.
6. Restarted the flyhub machine → `musher` revived, 46 batches drained.

Prod's credential is now **`liveone-prod-vercel-runtime-do-not-delete`** (`gpohd2xe1zc9`). The name
is the guardrail.

## Timeline (UTC; AEST = +10)

| | |
| --- | --- |
| 12:40–13:20 | migration `0063` applied to prod; ~20 temp roles created and deleted, correctly |
| **13:59:00** | last reading written to `point_readings` |
| **13:59:05.543** | `sydney-2026-07-14-depvs9` deleted — **outage begins** |
| 14:00 → | every DB route 500s; ingest stops fleet-wide; `fusher`/`musher` spool to disk |
| **17:58:00** | `musher`'s last journal entry — **collector dies, unnoticed** |
| 22:20 | outage reported by a human (08:20 AEST) |
| 22:25:15 | replacement role created; tested via `psql` |
| **~22:30** | env updated + redeploy → `/api/health` 200. **Outage ends (8 h 31 m)** |
| 22:30 → | ingest resumes; `fusher` spool drains; Kinkora Fronius back to 100% |
| 22:32:59 | least-privilege role created |
| ~22:36 | env swapped, redeployed, write verified; interim admin role deleted |
| **22:50** | flyhub restarted → `musher` alive; `spool: drained 46 batch(es) … 0 remaining` |

## Data loss

Measured per device against the same window 24 h earlier, counting **non-null 5-minute values per
series** — `before` immediately after the outage, `after` once the catch-up had run (2026-09-11
12:30 AEST). The catch-up itself is [outage-catchup.md](../outage-catchup.md).

| device | vendor | before | after | note |
| --- | --- | --- | --- | --- |
| Kinkora Fronius | `fusher` | **100%** | **100%** | spool drained itself — the machinery working as designed |
| OE NEM NSW / VIC | `openelectricity` | **100%** | **100%** | public API, backfilled by the normal poll before anyone looked |
| Kutis | `sigenergy` | 4% | **88%** | `liveone sync` — interval energy **100%**, power/SoC 82% (recovered wherever the vendor's `itemList` carried them) |
| Kutis · derived | `helper` | 5% | **100%** | rebuilt by `liveone device recompute` once Kutis landed |
| High Street Kew · derived | `helper` | 5% | **100%** | same |
| Amber ×2 | `amber` | price **100%**, usage 6% | unchanged | **not yet settled** — see below |
| Daylesford Generator | `deepsea` | 45% | 45% | spool recovered 13:42–17:58; **17:58–22:50 never collected (fault B)** |
| Daylesford Selectronic | `selectronic` | ~7% | ~7% | live-poll only, no history endpoint — **lost** |
| Kinkora Mondo | `mondo` | ~7% | ~7% | live-poll only — **lost** |
| Tez | `tesla` | ~13% | ~13% | live-poll only — **lost** |
| Kinkora Unified · derived | `helper` | 7% | 7% | blend needs Mondo — **bounded by a lost source** |
| Daylesford · derived | `helper` | 7% | 7% | blend needs Selectronic — **bounded by a lost source** |

🛑 **The original "Amber ×2 — 95%" was an artefact of blending all 34 series.** Every *pricing*
series (`grid.spot/rate`, `grid.import|export/rate`, `grid.renewables/proportion`) was 18/18 from the
start — `/prices` refilled itself. Every *usage* series (`grid.import|export/value`, `…/energy.delta`)
was and remains **1/18**. A single percentage over series of different cadence and different
provenance says nothing; measure per series, and group by what produced them.

### The daily aggregates were missing for BOTH days, fleet-wide

Not in the original assessment, and bigger than any single vendor's hole: `/api/cron/daily` runs at
14:05 UTC, which is **inside** the outage, so it 500'd — and the following night's run covers
*yesterday* only. Every device had **zero** `point_readings_agg_1d` rows for `2026-09-10`, and the
5-minute readings they roll up from were fine. `liveone device recompute <device> --start --end`
rebuilt all 14 devices; every one is now at parity with `2026-09-09`.

The lesson generalises past this incident: **an outage spanning a scheduled aggregation loses the
aggregate as well as the input, and the aggregate does not self-heal** — the nightly job's window is
relative to now, not to what is missing.

### Accepted holes — do not retry these

Recorded so a coverage sweep's "unrepaired" line is read as a known fact rather than a new fault:

| device | window (UTC) | why it is unrecoverable |
| --- | --- | --- |
| Daylesford Selectronic (1) | `2026-09-10 13:42 → 22:50` | live-poll vendor, no history endpoint |
| Kinkora Mondo (6) | `2026-09-10 13:42 → 22:50` | live-poll vendor, no history endpoint |
| Tez (10) | `2026-09-10 13:42 → 22:50` | live-poll vendor, no history endpoint |
| Daylesford Generator (14) | `2026-09-10 17:58 → 22:50` | `musher` was dead (fault B); the readings were never taken |

Measured uniformly across every series of each device, consistent to the interval — the generator's
50/110 is exactly the 13:42→17:58 the spool did recover. `liveone sync` **refuses** these vendors
rather than no-op'ing, so a retry is not merely useless, it is not expressible.

⚠️ **"Unrecoverable by LiveOne" turned out not to mean "unrecorded".** Both Selectronic and Mondo DO
have historical APIs behind their web portals; we had simply never looked. Neither is wired into
LiveOne yet, so the table above still describes what LiveOne holds — but the data exists:

- **Daylesford Selectronic** — [`2026-09-11-daylesford-selectronic-hourly.csv`](2026-09-11-daylesford-selectronic-hourly.csv)
  is the 24 hours around this outage, pulled from `select.live`. It covers the whole window at
  **hourly** resolution, and the battery tells the story plainly: SoC fell 100% → 31.5% overnight
  and did not begin recovering until solar returned at 08:00. Hourly is the vendor's floor.
- **Kinkora Mondo** — the outage window is recoverable **in full at 5-minute resolution**, including
  battery SoC, which LiveOne does not record at all today.

The plan for wiring both up is `.context/plans/vendor-history-legs-and-per-vendor-folders.md`. Until
a backfill has actually landed rows, this table stays as it is: it is currently wrong in the safe
direction, and editing it early would make it wrong in the unsafe one.

Two consequences that look like holes and are not: the **HWS modelled temperature** tracks its source
`load.hws/power` exactly (8/110 in the window), because a model cannot outrun its input — Mondo's
loss is its loss. And **Kinkora Unified · derived** / **Daylesford · derived** stay at 7% for the same
reason: their battery-provenance blend reads a device that has no data for the window.

### Still outstanding

**Amber usage, both devices.** `liveone sync 9|10002 --action=usage` reaches stage 3 and reports
`local usage is already equal or superior to remote` — Amber answered, and returned nothing for the
outage window that we do not already hold. A control run against `2026-09-08`, a day held completely,
exits at stage 1 (`already-held`), which is what proves the comparison is working rather than
mis-reading. Amber settles `/usage` over days: **re-run at T+3 (2026-09-14) and T+7 (2026-09-18)**,
and treat the current answer as "come back later", not "the data does not exist".

## Lessons Learned

1. **A credential's NAME is a safety control.** Prod ran for 58 days on a role whose name advertised
   it as a dated scratch credential, in an org where dated scratch credentials are created and
   destroyed several times a day. Nothing else distinguished it. Renaming it costs nothing and is
   the entire fix for this class.
2. **"The branch is ready" is not "the database is reachable."** Two different questions; the first
   one answering cheerfully is what made this look mysterious.
3. **The role id is in the username.** That one fact turns a mystery into a 30-second check, and it
   was not written down anywhere.
4. **`--ttl 0` or it is a scheduled outage.** A durable credential minted with the default TTL fails
   later, at a time nobody chooses.
5. **A minted `database_url` is not the prod URL.** Port 5432 vs the pooler's 6432 — copying it
   verbatim would have produced a second, subtler failure.
6. **Sibling collectors fail independently, and a healthy sibling is not evidence.** Kinkora's
   minutely `stored 13 readings (200)` made the hub look fine while Daylesford had been dead for
   hours.
7. **A static spool has two causes, not one.** The runbook named 4xx rejection; "the collector is
   dead so nothing calls drain" is at least as likely and is checked differently.
8. **Verify a database credential with a WRITE.** `SELECT 1` (and `/api/health`) would pass for a
   read-only role that silently breaks every poll.
9. **The routine self-heal is deliberately blind to fresh gaps.** Reaching for it during an incident
   produces a clean report and no repair.

## Action Items

- [ ] **Why did `musher` die and `fusher` survive?** Read `/data/usher/diag` for the 17:58 window.
      Until this is answered, assume any long receiver outage can silently kill a collector.
- [ ] **Per-site liveness alerting on the hub** — compare each site's journal rate against its own
      baseline and post to `OBSERVATIONS_ALERT_WEBHOOK_URL`. Would have caught fault B in minutes.
- [ ] **Why did nothing alert for fault A?** `/api/cron/monitor-observations` runs every 15 min;
      confirm what it does when the database it would report through is the thing that is down.
- [ ] **Audit every PlanetScale role for a misleading name**, in every org — this is a class, not an
      instance. A durable credential must be named for its consumer, never for a date.
- [ ] **`liveone catchup <since>`** — one verb for the ordered recovery in
      [outage-catchup.md](../outage-catchup.md) (spool → vendor → derived). The PRIMITIVES now exist
      (#455): `liveone sync` covers all three backfillable vendors and `liveone device recompute`
      does the scoped rebuild, so what is left is the orchestration and the measurement, not the
      levers.
- [ ] **A scoped lever for the fleet-wide daily pass.** `POST /api/cron/daily?action=regenerate`
      **504s** on a single past day (it re-runs HWS, battery learning, run periods and two reheal
      passes, most of them out to *now*, inside a 300 s budget) — so the one thing `device recompute`
      does not cover is currently unreachable by hand. It cost nothing here, because the only HWS
      pair's input was lost anyway, but it will matter the day it is not.
- [ ] **Alert when a scheduled aggregation does not run.** The missing `agg_1d` for both days was
      found by looking, not by being told.
- [ ] **Record accepted holes**, so a permanently-unrecoverable window stops being re-attempted and
      re-reported as a fault (the open gap already named in the coverage-repair framework).
- [ ] **Recompute derived rows** for 2026-09-10 once the sources are final (daily agg, run
      detectors, area flow/provenance).
- [ ] Consider **two credentials for prod** (or a documented break-glass), so restoring service does
      not depend on minting one under pressure.

## Status

- [x] Issue identified
- [x] Root cause determined (audit log, unambiguous)
- [x] Prod restored — 2026-09-10 22:30 UTC
- [x] Runtime credential replaced, renamed as its own guardrail, least-privilege, no TTL
- [x] Recovery verified with a write, not just a read
- [x] `musher` revived; 46 spooled batches recovered
- [x] Runbook written ([outage-catchup.md](../outage-catchup.md)); CLAUDE.md corrected
- [x] Vendor catch-up run — Kutis 4% → 88%; OE and Fronius were already whole (2026-09-11)
- [x] Derived rows recomputed for the affected days (agg_1d fleet-wide, area flow/provenance, run
      detectors) — 2026-09-11
- [x] Permanently-lost windows recorded as accepted, so they stop being re-reported
- [ ] Amber usage — awaiting settlement; re-run at T+3 (2026-09-14) and T+7 (2026-09-18)
- [ ] Fault B's cause understood
- [ ] Alerting closed for both faults
