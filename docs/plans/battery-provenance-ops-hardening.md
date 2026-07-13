# Battery energy provenance — correctness bugs & ops hardening

> **Status:** in progress. The two correctness **bugs (Part 1) are root-caused and FIXED in this branch**
> (with regression tests); the operational-ergonomics items (Part 2) remain as follow-ups. Surfaced while
> repricing Daylesford's off-grid generator on prod (2026-07-13). Code touched:
> `lib/aggregation/flow-matrix-core.ts`, `lib/db/planetscale/battery-provenance-pg.ts`; the
> recompute/flow-matrix APIs are unchanged. Feature name: **battery energy provenance**.

## How these were found

During the Daylesford generator reprice (config `generatorSource = {1000 g/kWh, 70 c/kWh, 0}`, after
#163 made it override the NEM region), the generator's **energy** total moved even though the device
runtime and readings were unchanged. That should be impossible — a metric (emissions/cost/renewable)
reprice must not touch the energy leg. Tracing it (git diff of #163 = metrics-only; then comparing the
`legacy` vs `modern` flow-matrix for the same area) surfaced two real defects. Measurements below are
`source.grid` (the generator) over full history via
`GET /api/energy-flow-matrix?systemId=1000002&start=2025-08-16&end=<yesterday>&source=legacy|modern`.

| view                                         | days | `source.grid` kWh | note                                            |
| -------------------------------------------- | ---- | ----------------- | ----------------------------------------------- |
| **legacy** (`flow_1d`, the reference Sankey) | 330  | **184.2**         | trustworthy; battery-provenance never writes it |
| modern (`flow_attr_1d`) **before** reprice   | 330  | 206.8             | already diverged from legacy (+22.6)            |
| modern **after** reprice (via the API)       | 307  | 164.4             | lost 23 days; diverged the other way (−19.9)    |

Decomposition of modern-after (164.4) vs legacy (184.2): **−42.4 kWh across 23 missing days spaced
exactly 14 days apart** (bug A), plus **+22.5 kWh concentrated on one day, 2025-09-17** (legacy 0 vs
modern 22.4 — bug B).

---

## Part 1 — Correctness bugs (root-caused & FIXED)

### Bug A — `recompute-provenance` drops one boundary day per window → coverage gaps when looped

**Symptom.** Re-running the full-history recompute through
`POST /api/areas/[areaId]/recompute-provenance` (which loops bounded 14-day batches) reduced Daylesford's
`flow_attr_1d` coverage from **330 → 307 days**. The 23 missing days are spaced **exactly 14 days apart**
— one per batch. The earlier full-history backfill used the **script** path
(`scripts/backfill-battery-provenance.ts` → `recomputeRange`, a continuous range) and had full coverage,
so the defect is specific to the discrete-window API loop.

**Where it is NOT.** `planFlowRecomputeBatch` (`lib/aggregation/flow-recompute-batch.ts`) tiles
contiguously and correctly (verified — batch _n_ oldest day and batch _n+1_ newest day are adjacent, no
gap).

**Root cause (confirmed).** `dayToUnixRangeForAggregation(newest)[1]` is **00:00 of `newest+1`** (the last
interval-end of `newest`). `localDaysInRange` mapped that timestamp with `toDay(endMs)` → calendar day
**`newest+1`**, so `writeAttrRollup` processed one day BEYOND the batch's loaded/folded window. That extra
day has no timeline coverage → empty matrix → but its per-day delete-then-insert still runs. In the
**backward** API loop, batch _k+1_'s `newest+1` equals batch _k_'s **oldest**, so it **wipes** the rows
batch _k_ correctly wrote → one lost day per 14-day seam = 23. (`planFlowRecomputeBatch` tiles correctly;
the script path self-heals via overlapping chunks, which is why only the API loop degraded.)

**Fix (applied).** `localDaysInRange` now maps the end boundary with `toDay(endMs - 1)`, so the range is
exactly `[oldest, newest]` — no `newest+1` overshoot, no wipe. Guarded by
`lib/db/planetscale/__tests__/local-days-in-range.test.ts`. (Unifying the API/script recompute paths so
they can't diverge again remains a nice-to-have — Part 2 #4.)

### Bug B — `modern` energy leg diverges from `legacy` for off-grid / generator

**Symptom.** Even at full coverage (before the reprice), modern `source.grid` = 206.8 vs legacy 184.2.
The entire +22.6 gap is one day, **2025-09-17: legacy 0 kWh, modern 22.4 kWh**. The core design invariant
is _the modern (`flow_attr_1d`) energy leg is the energy projection of the same accounting as the legacy
Sankey (`flow_1d`) — byte-identical_. It holds on the validated multi-device site (Kinkora) but is
violated here.

**Root cause (confirmed).** `computeFlowAccounting`'s per-day `window` filter checked only the interval
**END** (`timestamps[i+1] ∈ (startMs, endMs]`), so an interval whose START is before the day — a data-gap
or midnight-spanning interval — was attributed WHOLLY to the later day. The legacy `flow_1d` writer
(`recomputeFlowMatrixForDay`) integrates each day's samples **in isolation** and never sees that interval,
so the two diverge exactly where a gap spans local midnight (2025-09-17: a ~generator-run interval landed
on 09-17 in modern, on neither day in legacy).

**Fix (applied).** The window filter now requires the WHOLE interval to lie inside the day
(`timestamps[i] < startMs || timestamps[i+1] > endMs → skip`), making the per-day slice **byte-identical**
to the isolated per-day integration of `flow_1d`. The `window` param is passed **only** by the rollup
writer (`computeFlowMatrix` and the fold's accounting pass none), so the Sankey and live paths are
untouched. Guarded by the "per-day window == isolated per-day integration" tests in
`lib/aggregation/__tests__/flow-matrix-core.test.ts`.

**Blast radius (both bugs).** The user-facing **Sankey uses `legacy` and was always intact**. The affected
surface was the **provenance rollup + LoadProvenanceCard** (`?source=modern`) for **off-grid/generator**
areas. The fix restores `modern == legacy` for all areas by construction; **Daylesford needs a re-backfill
on the fixed code** to materialise it (Kinkora, effectively gap-free, is unaffected in practice).

---

## Part 2 — Operational hardening (ranked by leverage)

1. **A self-verifying consistency check — the highest-value item.** Assert, per area,
   `Σ modern energy (flow_attr_1d) == Σ legacy energy (flow_1d)` (and matching per-day coverage). Ship it
   two ways: (a) a **test** over both an on-grid and an off-grid fixture; (b) a **`monitor-observations`
   alert** so a live divergence pages instead of waiting for a human to hand-diff. This single check would
   have caught **both bugs above** automatically. **(Partly done:** the core-level "per-day window ==
   isolated per-day integration" regression test now guards the _math_ in `flow-matrix-core.test.ts`; the
   remaining piece is the per-area `Σ modern == Σ legacy` live **monitor alert**.)
2. **One "activate/reprice + verify an area" operation.** Repricing today means: discover the areaId,
   learn the flow-matrix shape, hand-loop the batch cursor, then hand-compute intensities from the raw
   matrix. Add a paired **`GET /api/areas/[areaId]/provenance-summary`** returning per-source intensities
   (g/kWh, c/kWh, %renewable, %estimated) **and** the legacy↔modern delta, so activate-then-verify is two
   calls. Ideally wrap the whole thing in an admin CLI `reprice-area <handle>`.
3. **A handle→areaId lookup.** `GET /api/areas` rejects a non-numeric id and there is no list endpoint;
   the Daylesford UUID had to be recovered from memory + scanning `/api/data`. Add
   `GET /api/areas/by-handle/<legacySystemId>` (or a list) returning the UUID.
4. **Unify the two recompute code paths** (API `planFlowRecomputeBatch` + per-window vs script
   `recomputeRange`). Same as Bug A's fix direction — one path, no silent divergence.
5. **Docs.** Add an "activate / reprice an off-grid area" runbook to
   `docs/architecture/battery-provenance.md` (the areaId lookup + the verify query). Fix the **stale
   CLAUDE.md** reference to `POST /api/admin/kv/build-registry` — that route no longer exists; the live
   mechanism is `buildSubscriptionRegistry()` via `refreshAreaServing` + `scripts/build-subscription-registry.ts`.
6. **Auth ergonomics for ops.** The API reprice needed the Chrome extension + a hand-written page-context
   fetch loop (a dev-minted Clerk JWT won't authenticate against prod). Either document a prod
   admin-token mint, or let the recompute endpoints accept `CRON_SECRET` (Bearer) for headless ops use.
7. **Minor DX.** The flow-matrix `sources`/`loads` are `{id,label,color}` objects, not strings — document
   the response type. (And note: the browser automation tool's safety filter blocks echoing query strings,
   so verification scripts must return only sanitized/structural values.)

## Scope decision (2026-07-13 review)

Assessed against Simon's filter — **only implement code that will be run again and makes systems ops
simpler**. The recompute path is not one-off tooling (it re-runs on every area activation, tariff/
intensity change, and re-backfill), so most of the list passes; two items are trimmed.

**Do (in order):**

1. **#1 remainder — the per-area `Σ modern == Σ legacy` live `monitor-observations` alert.** The math
   is now guarded by the `flow-matrix-core.test.ts` regression tests; the alert is what catches a live
   divergence unattended. Highest-leverage item; would have caught both Part-1 bugs.
2. **#2, endpoint only — `GET /api/areas/[areaId]/provenance-summary`** (per-source intensities +
   legacy↔modern delta + day coverage). Turns activate-then-verify into two calls; used on every
   future reprice/activation.
3. **#3 — handle→areaId lookup.** Tiny; needed at the start of every ops session against an area.
4. **#6 — accept `CRON_SECRET` Bearer on the recompute/provenance endpoints** (same pattern as
   `/api/cron/daily`). Removes the browser-extension/JWT dance for headless ops.
5. **#5 — the reprice runbook + fix the stale CLAUDE.md `build-registry` reference**; fold #7's
   response-type note into the runbook.
6. **#4 — unify the API/script recompute paths.** Both Part-1 bugs are already fixed with regression
   tests, so this is no longer a prerequisite — do it the next time the recompute is touched, so the
   two paths can't silently diverge again.

**Trim (fails the filter):**

- **The `reprice-area <handle>` admin CLI wrapper** (second half of #2): with the summary endpoint +
  `CRON_SECRET` auth a reprice is 2–3 curl calls; a CLI is a third code path to keep in sync with the
  engine. Revisit only if reprices become frequent.
- **#7 as standalone work:** nothing to build — one paragraph in the runbook.

## Verification / repro

- **Bug A repro:** on any battery area, run the `recompute-provenance` API loop over full history, then
  compare `?source=modern` day-count to `?source=legacy` — expect ~1 fewer day per 14-day batch.
- **Bug B repro:** compare per-day `source.grid` energy between `legacy` and `modern` for Daylesford
  (area handle `1000002`, UUID `019f513a-0d43-7c4b-b133-38f6e399fdd6`); 2025-09-17 shows legacy 0 vs
  modern 22.4.
- **Fix acceptance:** the Part 2 #1 invariant passes for both Kinkora and Daylesford; a looped API
  recompute yields identical coverage/values to the script path; a Daylesford re-backfill on the fixed
  code makes modern `source.grid` == legacy (184.2 kWh, full 330-day coverage) with the generator still
  priced at 1000 g/kWh · 70 c/kWh.

## Sequencing note

The Part-1 fixes ship **on this branch** (`simonhac/battery-energy-provenance`, with the Battery
Contents / opportunity-cost / export-tariff work). After it merges and deploys: **re-backfill
Daylesford once** on the fixed code (never on the pre-fix path), verify the acceptance numbers above,
then schedule the Part-2 "Do" list — the monitor alert first. Full merge choreography:
[`battery-provenance-merge-handoff.md`](battery-provenance-merge-handoff.md).
