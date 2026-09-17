# Runbook — retiring the Selectronic grid-sign transform

Status: **not yet executed.** Written 2026-09-17.

One-off. Moves Daylesford's `bidi.grid/power` from the vendor's sign (negative = import) to LiveOne's
canonical one (positive = import), and retires the `points.transform = 'i'` that reconciled the two
at read time.

## Why this is a cutover and not a deploy

The decoder's sign and the stored data's sign have to change together, and there is **no ordering
without a window where something reads backwards**:

| order | what breaks |
| --- | --- |
| rewrite history first | new readings still arrive in the old sign |
| flip the decoder first | new readings are canonical but `transform:'i'` still flips them |
| delete the read-time flips first | all 13 months invert at once |

So the deploy and the repair belong in one sitting. What the repair needs is a way to tell an
old-decoder row from a new-decoder one — and **that is the session, not the clock.**

A row is repaired iff `session_id IS NULL` or its session was created before `--cutover`. The
session records when *we polled*, so a message produced before the cutover is repaired however late
it lands and whatever vendor timestamp it carries. `measurement_time` cannot do this: a poll firing
after the cutover can carry an inverter timestamp from before it.

### What this replaces, and why

An earlier draft paused the `live` ingest lane and drained it. That was abandoned:

- **Pausing stops dispatch, not polling.** The collectors keep publishing, so messages produced
  before the cutover sit in the outbox and land *after* the repair has finished validating.
- **The race is not winnable.** The lane is fleet-wide, so messages arrive continuously from every
  vendor; draining to zero and pausing still caught 2 in flight, twice.
- **Stopping the poller instead would leave a permanent hole.** Selectronic is a live-poll vendor
  with no history endpoint — `lib/vendors/sync-legs.ts` covers amber, sigenergy and openelectricity
  only, and `liveone sync` refuses the rest rather than backfilling. A gap could never be filled.

With the session boundary, **none of that is needed**: the repair is safe against live ingest, no
polls are stopped, and nothing is lost.

## Scope

- One device (`1`, Daylesford Selectronic), one point (`pt_5v404b4m93bf8aytkrzvhvs3z1`).
- ~534k raw readings, 2025-08-30 → now; ~108k five-minute intervals.
- A fleet census found this is the **only** point carrying `transform: 'i'`. Every other transform is
  `'d'` on an energy counter, which is unrelated and stays.

🛑 The census read `points.transform` only. `area_bindings.transform` can override it
(`lib/battery-provenance/load.ts`), so confirm no binding sets one for this point before starting.

## Before you begin

- Do it in daylight, and **not** on a Thursday morning — the generator exercise slot is Thu 07:00
  and its `unless` clause reads this point. (Step 1 disarms it anyway; this is belt and braces.)
- Confirm a recent PITR window and take a base backup: `pscale backup create liveone sydney`.
- Have `docs/architecture/energy-flow-matrix.md` open if you need to re-derive which way is canonical.

## The steps

Ingest keeps running throughout. Nothing is paused, nothing is stopped, no poll is lost.

```bash
# 1. Disarm the automation — it reads this point, and during the window its 7-day lookback spans
#    both conventions. Nothing else is touched.
npm run liveone -- automation disable ar_01kx8km3a3fh5v2csryvhskzep 'Generator exercise' --apply --yes

# 2. Note the cutover instant, then deploy. Take T from the deploy, and err EARLY: a T before the
#    deploy leaves a few new-sign rows unrepaired (visible, fixable); a T after it negates
#    canonical rows (not fixable without knowing which).
date -u +%Y-%m-%dT%H:%M:%SZ        # ← this is T; record it
gh pr merge 530 --squash
./scripts/utils/wait-for-deploy.sh

# 3. Repair. Dry run first: it prints how many sessions predate T, how many rows qualify, and how
#    many are skipped as already-canonical. That skip count should be roughly the polls since T.
npx tsx --env-file=.env.local scripts/utils/normalise-selectronic-grid-sign.ts --cutover=<T>
npx tsx --env-file=.env.local scripts/utils/normalise-selectronic-grid-sign.ts --cutover=<T> --apply

# 4. Rebuild what the raw repair invalidated but did not touch.
npm run liveone -- device recompute 1 --start 2025-08-30 --end <today> --apply
#    …then the battery fold + Sankey, looping on nextCursor:
#    POST /api/v4/areas/ar_01kx8km3a3fh5v2csryvhskzep/recompute-provenance

# 5. Re-enable the automation.
npm run liveone -- automation enable ar_01kx8km3a3fh5v2csryvhskzep 'Generator exercise' --apply --yes
```

🛑 **`--env-file=.env.local` points at `liveone-dev`, not prod.** To repair production, mint a
short-TTL write role (`pscale role create liveone sydney <name> --ttl 30m`), pass its URL as
`PLANETSCALE_DATABASE_URL`, and set `ALLOW_PROD_DB_IN_DEV=true` — `assertDbEnvironmentMatches` is
fail-closed and will otherwise refuse the prod connection from a laptop. Delete the role afterwards.

🛑 **Never `liveone area purge flows`.** It deletes days that `rehealStaleAttrDays` will never look
for again — it finds work by selecting *from* that table, so a deleted day is absent rather than
stale. Only an explicit `recompute-provenance` over the range restores them.

## Verifying

The two reads that disagreed are the test:

```bash
npm run liveone -- device latest 1 --format json | jq '.latest["bidi.grid/power"].value'
npm run liveone -- device history 1 --last 1d --interval 5m --format csv | ...
```

They must now **agree in sign**, and both read positive while the generator is supplying. Also:

- `min ≤ avg ≤ max` holds on every `bidi.grid/power` bucket (it did not, while the transform
  negated each aggregation field without exchanging the extremes).
- `liveone area flows` books generator energy as `source.grid`, on both a sub-daily window (computed
  live) and a long-range one (served from `flow_attr_1d`). A disagreement between those two means
  the materialised rows predate the repair — go back to step 6.

## If it fails part-way

The writes are chunked and non-transactional, so a crash leaves the table **half-flipped**.

- ✅ **Re-run the script.** It resumes from `.selectronic-sign-watermark.json`.
- 🛑 **Do not delete the watermark and re-run.** That negates the already-repaired rows a second
  time, returning them to the old sign while the rest stay canonical — and nothing downstream will
  tell you, because the row counts still reconcile.
- The `transform = 'i'` guard is cleared only on complete success, so a finished run refuses to run
  again. It says nothing about a run that died.
- Re-running with a DIFFERENT `--cutover` than the first attempt would repair a different set of
  rows. Use the T you recorded, not a fresh one.

## Afterwards

**`liveone-dev` will not heal itself.** The 2-hourly sync copies `points` wholesale but inserts raw
readings `ON CONFLICT DO NOTHING`, so dev would take `transform: null` from prod while keeping
old-sign raw history — and the repair script would then refuse to run there, its guard having
vanished. Restore dev from the post-repair R2 dump (`scripts/utils/restore-drill-pg.sh`, the
documented seed path) rather than reasoning about sync semantics.

**Then a follow-up PR** deletes the now-dead read-time flips, which is only safe once nothing carries
the transform:

- `lib/history/build-series.ts` — the `'i'` branch of `applyTransform`, and the min/max exchange
- `lib/aggregation/flow-series.ts` — `applyPowerTransform`, and its callers in `flow-series-pg.ts`
  and `lib/battery-provenance/load.ts`
- `lib/collectors/interval-comparison.ts`
- `app/api/admin/devices/[systemId]/point-readings/route.ts`
- `PATCH /api/device/{systemId}/point/{pointId}` — stop accepting `'i'` at all
- keep `applyEnergyTransform` / `'d'`: that is a live, correct mechanism for energy counters
