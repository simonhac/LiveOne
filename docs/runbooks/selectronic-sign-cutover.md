# Runbook — retiring the Selectronic grid-sign transform

Status: **not yet executed.** Written 2026-09-17.

One-off. Moves Daylesford's `bidi.grid/power` from the vendor's sign (negative = import) to LiveOne's
canonical one (positive = import), and retires the `points.transform = 'i'` that reconciled the two
at read time.

## Why this is a cutover and not a deploy

The adapter's sign and the stored data's sign have to change together, and there is **no ordering
without a window where something reads backwards**:

| order | what breaks |
| --- | --- |
| rewrite history first | new readings still arrive in the old sign |
| flip the decoder first | new readings are canonical but `transform:'i'` still flips them |
| delete the read-time flips first | all 13 months invert at once |

Pausing ingest is what collapses the problem. With writes stopped, every row present is old-decoder
**by construction**, so `max(measurement_time)` is the legacy boundary — no deploy-timestamp
heuristic, and no reasoning about in-flight polls landing older measurement times after the cutover.
It also reduces resumability from a per-row original→target manifest to a single watermark, because
nothing below the watermark can change while the repair runs.

`queue pause` stops **dispatch** only — publishing is unaffected and the outbox keeps accepting — so
nothing is lost. The queued readings land canonical after the resume.

## Scope

- One device (`1`, Daylesford Selectronic), one point (`pt_5v404b4m93bf8aytkrzvhvs3z1`).
- ~534k raw readings, 2025-08-30 → now; ~108k five-minute intervals.
- A fleet census found this is the **only** point carrying `transform: 'i'`. Every other transform is
  `'d'` on an energy counter, which is unrelated and stays.

🛑 The census read `points.transform` only. `area_bindings.transform` can override it
(`lib/battery-provenance/load.ts`), so confirm no binding sets one for this point before starting.

## Before you begin

- Do it in daylight, and **not** on a Thursday morning — the generator exercise slot is Thu 07:00
  and its `unless` clause reads this point.
- Confirm a recent PITR window and take a base backup: `pscale backup create liveone sydney`.
- Have `docs/architecture/energy-flow-matrix.md` open if you need to re-derive which way is canonical.

## The steps

```bash
# 1. Stop dispatch, and disarm the automation so nothing acts on mixed-sign data.
npm run liveone -- queue pause --lane live --apply --yes
npm run liveone -- automation disable ar_01kx8km3a3fh5v2csryvhskzep 'Generator exercise' --apply --yes

# 2. Drain. Wait for in-flight to reach 0 — the repair refuses otherwise, and a message landing
#    mid-repair would write an old-sign row below the watermark, invisible to the validation.
npm run liveone -- queue status

# 3. Deploy the decoder flip (this PR). Nothing is landing, so nothing is written either way.
./scripts/utils/wait-for-deploy.sh

# 4. Repair. Dry run first — it prints the span, the row count, and how many values are positive
#    (expect a handful out of ~534k; an off-grid AC input essentially only ever imports).
npx tsx --env-file=.env.local scripts/utils/normalise-selectronic-grid-sign.ts
npx tsx --env-file=.env.local scripts/utils/normalise-selectronic-grid-sign.ts --apply

# 5. Resume. Everything downstream is an idempotent recompute and is safe against a live table.
npm run liveone -- queue resume --lane live --apply --yes

# 6. Rebuild what the raw repair invalidated but did not touch.
npm run liveone -- device recompute 1 --start 2025-08-30 --end <today> --apply
#    …then the battery fold + Sankey, looping on nextCursor:
#    POST /api/v4/areas/ar_01kx8km3a3fh5v2csryvhskzep/recompute-provenance

# 7. Re-enable the automation.
npm run liveone -- automation enable ar_01kx8km3a3fh5v2csryvhskzep 'Generator exercise' --apply --yes
```

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
