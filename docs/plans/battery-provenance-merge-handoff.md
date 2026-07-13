# Battery-energy-provenance branch — merge handoff

> **Status:** active checklist. Owns the pre-merge gates and post-merge/deploy choreography for the
> `simonhac/battery-energy-provenance` branch (memphis-v3 workspace). Written 2026-07-13 after an
> independent review verified the branch's two bug fixes against code + raw dev-mirror data.
> Companions: [`battery-provenance-ops-hardening.md`](battery-provenance-ops-hardening.md) (the bugs +
> the ranked ops follow-ups), [`info-producers-consumers.md`](info-producers-consumers.md) (the
> resolver design this branch unblocks).

## What the branch contains

- **Battery Contents card** (replaces BatteryBlendCard): inventory valuation of the store — usable
  kWh, total carbon + intensity, actual + forgone-export cost, renewable %, export value. Two new
  derived helper points (`bidi.battery/stored-energy`, `bidi.battery/price-opportunity`) via the
  existing BLEND_POINTS mechanism — **no schema change, no migration**.
- **Solar opportunity cost, first-class**: a parallel `costOppC` accumulator in the fold (actual @
  solar-0, opportunity @ feed-in) emits `batteryPriceOpportunity` alongside `batteryPrice`; the
  either/or `solarValuation` toggle is retired.
- **Pluggable export tariff** (`lib/battery-provenance/tariff.ts`): `{none | amber | schedule}` →
  the single `exportPrice[]` series the fold consumes; config on
  `systems.config.batteryProvenance.exportTariff`, validated in the admin config route (TOU
  schema-reserved, rejected until built).
- **Both rollup correctness bugs fixed** (see ops-hardening Part 1): the batch-seam day wipe
  (`localDaysInRange` `toDay(endMs − 1)`) and the gap-spanning-interval misattribution
  (whole-interval-inside-window filter in `computeFlowAccounting`). Regression tests for both.

Review notes (2026-07-13): fold accumulator parity checked at every mutation site; point
registration is incremental (new points self-register on systems that already have the original
three); the `battery-blend` → `battery-contents` card rename was verified safe — **no persisted
dashboard descriptor contains either card type** (checked on the dev mirror, which reflects prod
config). Raw-data verification of Bug B: 41-hour outage 2025-09-15 16:05 → 2025-09-17 09:00 local
(the 16th has zero rows), raw grid energy ≈ 0 all that week — legacy's 0 kWh was correct.

## Pre-merge (on this branch)

1. **Docs consolidation** — DONE in-tree (uncommitted as of writing): `info-producers-consumers.md`
   coordination retargeted to this branch + review corrections folded in;
   `battery-provenance-ops-hardening.md` scope decision added; this handoff.
2. **CLAUDE.md one-liner** (ops-hardening #5, docs-only quick win): fix the stale
   `POST /api/admin/kv/build-registry` reference → `buildSubscriptionRegistry()` via
   `refreshAreaServing` + `scripts/build-subscription-registry.ts`.
3. **Gates:** full `npm test` (not just the new suites), then `npm run build:local && npm run
typecheck` before committing (repo rule — never plain `npm run build`).
4. **Offline replay validation** on the `liveone-dev` mirror (`scripts/replay-battery-provenance.ts`,
   `tsx --env-file=.env.local`): Kinkora + Daylesford full history —
   - actual-cost basis (`batteryPrice`) **byte-identical** to pre-branch output;
   - opportunity ≥ actual everywhere; opportunity == actual under `--solar none`;
   - conservation self-audit 0.00%.
5. **Card gallery** (`/labs/card-gallery`): BatteryContentsCard renders the warm-up/degraded states
   (intensities present but no `stored-energy` → totals show "—"; no export tariff → export stat
   hidden).
6. **PR** to `main` (`gh pr create --base main`). No migration to apply — config is JSONB + code.

## Post-merge / deploy

1. **Deploy** (automatic from main). First recompute per battery area self-registers the two new
   points on the helper device, binds them into the Area (`ordinal` 100+), and rebuilds the KV
   subscription registry (`bind.created > 0` path). **Verify** for Kinkora (area 8) and Daylesford
   (1000002): KV latest carries `bidi.battery/stored-energy` + `bidi.battery/price-opportunity`, and
   the Battery Contents card renders on both dashboards.
2. **Re-backfill Daylesford ONCE, on the fixed code** — never on a pre-fix deploy (sequencing rule
   from ops-hardening). Script path (`scripts/backfill-battery-provenance.ts`) or the now-fixed API
   loop; both should now agree.
3. **Acceptance** (the empirical proof of both fixes, including the shared 00:05 boundary-interval
   convention): Daylesford modern `source.grid` == legacy **184.2 kWh over the full 330 days** with
   the generator still priced 1000 g/kWh · 70 c/kWh · 0; per-day coverage identical; Kinkora
   spot-check unchanged. Do the read-back on **prod** (the 2-hourly dev sync overwrites dev-side data
   edits, so dev-only writes don't stick).
4. **Kinkora export tariff**: set `exportTariff = { mode: "amber" }` in the device config (battery
   system), then run the recompute so `price-opportunity` diverges from `price` where feed-in was
   forgone. Daylesford stays tariff-less (`none` — generator site; opportunity == actual).
5. **Ops-hardening Part-2 "Do" list, in its order** (see that doc's Scope decision):
   the `Σ modern == Σ legacy` **monitor alert** first, then `provenance-summary`, handle→areaId
   lookup, `CRON_SECRET` auth on the recompute endpoints, the reprice runbook; path unification when
   the recompute is next touched.
6. **Unblock info-producers P2** (the resolver): implementing workspace branches from the merged
   main; `TariffProvider` → `resolveInfoSources` generalization per the updated plan doc. The FE
   "Recompute provenance" action (the currently un-called
   `POST /api/areas/[areaId]/recompute-provenance` + `lib/areas/recompute-flow.ts` idiom) lands with
   its P3.

## Rollback / safety notes

- No migration, no flag: rollback = revert the merge commit. The two new `point_info` rows and their
  agg_5m/KV data are inert under old code (unknown metricTypes are simply not read).
- The rename is data-safe (verified above); the only renderer change is the card switch, and unknown
  card types render `null` (no crash).
- `flow_attr_1d` is delete-then-insert idempotent per (area, day) — a re-backfill is always safe to
  re-run.
