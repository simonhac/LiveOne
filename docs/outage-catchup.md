# Catching up after downtime

**Status:** written 2026-09-11, from the first real exercise of it (an 8.5 h prod database outage).
Companion to [coverage-repair.md](architecture/coverage-repair.md), which is the *routine* self-heal.
The exercise that produced it: [2026-09-11 prod down — PlanetScale role deleted](incidents/2026-09-11-prod-down-planetscale-role-deleted.md).

The routine machinery is deliberately unhurried: `/api/cron/repair-coverage` skips the trailing
**7 days** (`graceDays: 7` on all three providers), because Amber is still settling and re-fetching
an unsettled day only means repairing it twice. That is right for the weekly sweep and useless in
the hour after an outage — **the gap you are staring at is the one window the self-heal cannot
see.** Hence this document.

> 🛑 **Recovery is a race for exactly one class of data: what is buffered on a collector.** The
> usher spool and the vendor APIs both hold their contents for a while, but a collector that has
> *stopped* is producing nothing new, and nothing recovers a reading that was never taken. Do the
> spool first, in the first minutes; the vendor-API backfills keep for days.

## 0. Establish the window

```bash
# Prod, read-only. The gap is [last_reading_before_recovery, first_reading_after].
psql "$PROD_URL" -tAc "select max(measurement_time) from point_readings"
```

Record the start and end as UTC timestamps. Everything below is scoped to that window.

## 1. Measure the hole, per device, against a baseline

A raw row count means nothing on its own — devices differ by orders of magnitude in point count and
cadence. Compare the gap window against **the same window 24 h earlier**:

```sql
with gap as (
  select p.device_id, count(*) n from point_readings_agg_5m a join points p on p.rid=a.point_rid
  where a.interval_end > timestamp '<GAP START>' and a.interval_end <= timestamp '<GAP END>'
  group by 1),
base as (
  select p.device_id, count(*) n from point_readings_agg_5m a join points p on p.rid=a.point_rid
  where a.interval_end > timestamp '<GAP START -24h>' and a.interval_end <= timestamp '<GAP END -24h>'
  group by 1)
select d.rid, d.name, d.vendor, coalesce(base.n,0) baseline, coalesce(gap.n,0) have,
       case when coalesce(base.n,0)=0 then 'n/a'
            else round(100.0*coalesce(gap.n,0)/base.n)::text||'%' end pct
from devices d left join gap on gap.device_id=d.id left join base on base.device_id=d.id
where d.status='active' order by d.rid;
```

Re-run this after every recovery step. It is the only honest progress measure, and a device sitting
at 100% needs nothing done to it.

## 2. Drain the usher spool — FIRST, and check the collector is alive

Push vendors on the flyhub (`fusher` = Kinkora Fronius, `musher` = Daylesford DeepSea) spool
undelivered batches to disk on a **transient** failure and re-send them idempotently. A database
outage is transient, so this data is usually fully recoverable.

```bash
fly ssh console -a liveone-flyhub -C "sh -c 'ls /data/usher/spool | wc -l; du -sh /data/usher/spool'"
```

- **Draining (count falling):** nothing to do; it self-heals.
- **Empty:** either it already drained, or the collector never spooled — go to step 3.
- **Non-empty and STATIC:** the runbook's usual reading is "pushes are being rejected (4xx)". ⚠️
  2026-09-11 found a second cause, and it is the one to check first: **the collector itself was
  dead**, so nothing was calling drain.

🛑 **Always check per-site liveness, not just the spool.** The journal records every successful
tick, and the two sites fail independently:

```bash
fly logs -a liveone-flyhub --no-tail | grep -E "\[(sheephouse|kinkora)\]" | tail
fly ssh console -a liveone-flyhub -C "sh -c 'grep -hc sheephouse /data/usher/blackbox/$(date -u +%F).jsonl; grep -hc kinkora /data/usher/blackbox/$(date -u +%F).jsonl'"
```

A site with *no* lines, or a journal count far below its sibling's, has stopped. Confirm the
network is innocent (`wg show wg0` — both peers with a recent handshake; `ping 10.0.1.244` for the
DeepSea, **not** the Fronius, which does not answer ICMP), then restart:

```bash
fly machine restart <id> -a liveone-flyhub    # safe while the generator is idle — check first
```

🛑 Check `control_state` / `engine_rpm` in the latest journal line before restarting: a restart
during a latched generator run resumes the deadline but does take the machine down.

The spool drains within a minute or two of the collector coming back; confirm with
`spool: drained N batch(es) … 0 remaining` in the logs, then re-run step 1.

## 3. Vendor backfills — what is actually recoverable

**One verb covers every vendor that has a history API**, because they are one concept — *one device,
one window, re-fetch what the vendor still holds*:

```bash
npm run liveone -- sync <device> --start=YYYY-MM-DD --end=YYYY-MM-DD          # dry run
npm run liveone -- sync <device> --start=YYYY-MM-DD --end=YYYY-MM-DD --apply
```

It reports `published` (what went onto the backfill lane) and `landed` (a read of the serving store
after the lane drains) as separate numbers, and a zero says which of the three zeros it is. Per
vendor:

| vendor | recoverable | how |
| --- | --- | --- |
| `fusher` / `musher` (flyhub) | ✅ fully, while spooled | step 2 — nothing to call |
| `openelectricity` | ✅ | `liveone sync`; the normal poll usually beats you to it |
| `amber` | ✅ (~90-day window) | `liveone sync --action=usage\|pricing\|both` — the only vendor with an action axis |
| `sigenergy` | ⚠️ **energy + most power/SoC** | `liveone sync`; power/SoC come back wherever the vendor's `itemList` carried them (`derive-power.ts`), and the nightly cron re-does a trailing 7 days anyway |
| `selectronic`, `mondo`, `tesla` | ❌ | live-poll only — no history endpoint. What was not polled is gone, and `sync` refuses rather than looking like a fix. |
| `helper` (derived) | ✅ | recompute from the repaired sources — step 4 |

🛑 **A sync does NOT rebuild derived tables** — not for any vendor. It cannot: a rebuild has to wait
for the lane to land, and the route's budget is 45 s. Step 4 is the other half, and a run that
published anything prints the exact command.

Forcing a repair *inside* the 7-day grace is the thing not to do. The runner reads its override from
the env var **`REPAIR_SETTLEMENT_GRACE_DAYS`** (`GRACE_DAYS_OVERRIDE` is the const, not the knob), at
**module scope** — so changing it on prod is a Vercel env change plus a redeploy, and a second
redeploy to revert. It also re-fetches days that are still settling. The per-vendor `liveone sync`
above reaches the same window directly, with none of that.

## 4. Rebuild everything derived from the repaired days

Derived rows are pure functions of their sources, so they must be recomputed **after** the sources
are as good as they are going to get, or they bake in the hole. Two verbs, both scoped, both naming
their window:

```bash
# agg_1d + the attributed flow matrix of every Area this device's points bind into
npm run liveone -- device recompute <device> --start=<gap day> --end=<gap day> --apply

# run detectors (generator runs, EV charge sessions) — one derivation, one day
npm run liveone -- derivation recompute <dx_…> --date=<gap day> --apply
```

🛑 **Neither has an unscoped form, and that is the point.** Their fleet-wide twins do:
`POST /api/cron/daily {"action":"regenerate"}` with no date resolves to *all available history*
(`parseDateParams`), and the derivations cron's filter is optional — a full-range unscoped regenerate
through it once collapsed 71 dev rows to 3. Reach for `/api/cron/daily` only when you mean the whole
fleet, and always with a `date=`; it is also the only thing that re-runs the fleet-wide HWS, battery
learning and backlog reheal passes, which is why it costs a 300 s budget and `device recompute` does
not.

## 5. Write down what stayed lost

A permanently-missing window is a fact about the data, not a failure to be retried nightly. Note it
(device, window, why unrecoverable) so the next sweep's "unrepaired" line is not read as a new
fault — this is the open gap named in the coverage-repair framework: nothing yet records that a
hole has been *accepted*.

## What this exercise showed should be built

1. **A single `liveone catchup <since>` verb.** Every step above is manual, and the ordering
   (spool → vendor → derived) matters. Doing it by hand at 2 am is how a step gets skipped.
   *(Partly done: steps 3 and 4 are now verbs — `liveone sync` covers all three backfillable
   vendors and `liveone device recompute` rebuilds the scoped derived rows — so what is left to
   build is the orchestration, not the primitives.)*
2. **Per-site liveness alerting on the hub.** Kinkora kept collecting while sheephouse was dead for
   ~5 h and nothing said so; the outage was noticed by a human looking at a dashboard. A watchdog
   comparing each site's journal rate against its own baseline would have caught it in minutes.
3. **Why did one collector die and not the other?** `fusher` survived the same receiver outage that
   killed `musher` at 17:58, ~4 h in. Until that is understood, assume any long receiver outage can
   silently kill a collector, and check liveness explicitly (step 2).
