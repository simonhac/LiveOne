# Battery SoC ↔ meter reconciliation — findings & fold-model improvement plan

**Status: IMPLEMENTED on this branch (2026-07-15), all phases. P1+P2 (fold three-term loss model +
recal snaps + learner exclusion) validated on the dev mirror: Daylesford sync churn −44%, recal=2 on
2026-06-25, Kinkora `--no-soc` byte-identical; full-history learner fit η_c 0.944 / idle 0.454 kWh/day
≈ the SQL ground truth 0.940 / 0.473. P3 = monitor check 5c (`batprov_soc_meter_divergence`,
`lib/battery-provenance/soc-meter-check.ts`). P4 = closed out in
`docs/architecture/battery-provenance.md`. Not deployed — needs merge → deploy → per-area
recompute-provenance (first batch learns + persists η_c/idle).**

## Why

PR #168 (SoC-anchored fold overlay) shipped with one open data-quality caveat: _"Daylesford's SoC
rises ~39pp over 40 days while metered net energy ≈ 0 — the SoC and the charge/discharge registers
disagree."_ The SoC anchor compensates (visible in the `sync*` buckets), but if a meter were lying,
every downstream number (blend, usable kWh, learned η/C) would be built on sand. This document
records the read-only prod investigation that resolved the caveat, and the model improvements it
points to.

## Findings (prod `sydney`, read-only; Daylesford = system 1 Selectronic, points 5/7/13/14)

**The feared meter-vs-SoC disagreement does not exist.** Daily/weekly/monthly reconciliation of
SoC-implied energy (`ΔSoC/100 × C`, C = 65.3 kWh) against the charge/discharge Wh registers over the
full 322-day history closes under a simple 3-term physical model (least-squares, recal day excluded):

```
stored_kWh/day ≈ 0.940 · charge_kWh  −  0.991 · discharge_kWh  −  0.473
```

1. **Charge-side efficiency ≈ 94.0%** — SoC rises by ~94% of each metered charged kWh.
2. **Discharge ≈ 1:1** (coefficient −0.991) — also a capacity cross-check: it implies
   `C·η_d ≈ 64.7 kWh`, agreeing with the learned C = 65.3.
3. **Constant idle drain ≈ 0.47 kWh/day (~20 W)** — BMS/balancing/self-discharge, proportional to
   _time_, not throughput.
4. **BMS full-charge recalibration snaps** — jump detection over 120d found exactly 2 events, both
   2026-06-25: 85.5→90.7% after a 1h data gap, then 96.4→100.0% at −77 W (idle). Net ≈ +5.7 kWh of
   SoC appearing with no metered energy: the BMS re-syncing its coulomb counter at full charge,
   paying back accumulated downward drift in one step. This single day produced the +9 kWh daily
   residual; every other day in 45 days reconciles to ~±1 kWh.
5. The registers also agree with the power integral (`Σ avg·Δt`) day by day (positive battery power
   = discharge on this feed).
6. Overnight charge is ≈ 0.00 kWh essentially every night — the "unattributed overnight charge"
   that motivated Defect 1 is (now) negligible at Daylesford.
7. The learned single η (Σout/Σin over matched SoC ≈ 86.5%, wobbling 82–88% day to day) is a
   _round-trip average that conflates all three terms_: 0.94 × 0.99 ≈ 0.93 per cycled kWh, minus the
   20 W time-tax on parked energy ≈ high-80s effective at Daylesford's ~10 kWh/day throughput. The
   wobble is the throughput-to-idle ratio changing, not the battery changing.
8. The original "SoC +39pp with net ≈ 0" claim does not reproduce against prod registers in any
   window; it was an artifact of the dev-replay era (power-integration over a gappy mirror window).
   The true signature is the opposite sign and fully explained by the loss terms above.

**Consequence for the current fold:** `fold.ts:422` books `E += η·charge` with the _round-trip_ η
(≈0.865), while the true charge-side ratio is ~0.94. So E under-grows ~7–8% of every charged kWh and
never pays the idle drain — and the SoC anchor then continuously up-syncs the difference back in.
Correct outcome, wrong mechanism: the sync bucket is doing the work a better loss model should do.

## Improvement plan

### P1 — Three-term loss model in the fold (the core change)

Replace the single charge-time η with the physically-separated terms:

- `E += η_c · chargeKwh` (charge-side efficiency, learned ≈ 0.94)
- `E −= dischargeKwh` (η_d fixed ≡ 1; the fit's −0.991 flows into C via the existing capacity
  learner — avoids the C/η_d degeneracy)
- `E −= idleW · Δt` each interval, booked to a new `idleLoss*` bucket that drains all provenance
  buckets pro-rata (identical math to the provenance-neutral down-sync scaling) — so parked energy
  pays the standby tax over time instead of charging sources paying it up front.
- Conservation identity extends: `chargedG + syncG == vendedG + unattribLossG + idleLossG + carbonG`.

Learner: a daily joint regression (exactly the LSQ used in this investigation — normal equations
over per-day `[ΔSoC·C, chargeKwh, dischargeKwh]`) learning `(η_c, idleKwhPerDay)`, run in the daily
shell next to `learnAndPersistEta`/`learnAndPersistCapacity`, same fixed-anchor + persisted-point
reproducibility contract (two new helper points, e.g. `charge-efficiency`, `idle-loss`). Gating:
min-throughput days only, recal days excluded (see P2), clamp to sane bands (η_c ∈ [0.8, 1.0],
idle ∈ [0, 2] kWh/day). SoC-blind history (Kinkora's 7-month gap) → learner yields nothing → fold
falls back to today's single-η path, byte-identical — same fallback contract as the SoC overlay.

### P2 — Treat BMS recalibration snaps as re-anchor events, not energy

Detect: one interval where `|ΔSoC/100·C − metered interval energy| > ~2 kWh` (or SoC lands ≥ 99.5).
Handle: snap E to the SoC target in **one step** (bypass `syncGamma` smoothing), log it as a distinct
`recal` entry in the reset/sync log (inspector-visible), and **exclude that local day from all
learners** (η_c/idle/C/η) so a +9 kWh correction can't bias a day's fit. A snap-to-100 is also the
true "full" anchor — the mirror of the `empty` reset for a battery that never empties.

### P3 — Standing monitor: `batprov_soc_meter_divergence`

Turn this investigation into a daily per-battery-area check in `monitor-observations`:
`|ΔSoC·C − (η_c·chg − dis − idle)| > tol` (start: 3 kWh/day, over complete days ≤2 days ago) → warn.
Silences the benign case by construction (the model now explains it) and catches _real_ meter or SoC
feed failures — the thing the original caveat feared. Recal snaps surface here too (expected-rare).

### P4 — Docs & closeout

- Close the PR-#168 caveat in `docs/architecture/battery-provenance.md` ("Not yet" list): link the
  three-term findings; the "registers disagree" caveat is resolved as η_c + idle drain + BMS recal.
- While there, also record the other undocumented #168 deferral: the reserve floor is the one input
  not fixed-anchor-reproducible (sliding 90d percentile, KV ~25h TTL, bounded ≤~2.6 kWh by the
  [5,10] clamp) — candidate for the same persisted-point treatment as η/C.

## Files touched (expected)

- `lib/battery-provenance/fold.ts` — η_c/idle terms, `idleLoss*` buckets, recal snap handling,
  extended conservation identity
- `lib/battery-provenance/eta.ts` (or new `losses.ts`) — the joint (η_c, idle) daily regression
- `lib/battery-provenance/capacity.ts` — recal-day exclusion
- `lib/battery-provenance/{compute,load,types,register}.ts` + `lib/db/planetscale/battery-provenance-pg.ts`
  — plumb + persist the two new helper points (mirror the η/C pattern end to end, incl. recompute
  route first-batch + daily shell + backfill)
- `app/api/cron/monitor-observations/route.ts` — P3 check
- `scripts/replay-battery-provenance.ts` — print the new terms + recal log
- Tests: fold property tests (conservation with idleLoss; recal snap; η_c path), learner regression
  fixtures from the real Daylesford dailies

## Validation gates (same bar as #168)

- Property tests green; conservation residual 0.00% on replay.
- Dev-mirror replay before/after on **both** areas: Daylesford daily |SoC-vs-model residual| p95
  < ~1 kWh, `syncKwh` churn drops materially (the anchor should become a trim, not a pump), 2026-06-25
  shows one `recal` event and no learner pollution; **Kinkora `--no-soc` byte-identical** (no
  regression on SoC-blind history).
- Blend deltas small and explainable (losses re-timed, not re-invented).
- Then: merge → deploy → per-area `recompute-provenance` (builds the new points) — same activation
  choreography as #168.

## Explicitly out of scope

- Any vendor/collector change (the Selectronic feed is healthy — that was the point of the investigation).
- Reserve-floor fixed-anchoring (documented in P4, scheduled separately).
- The info-producers/consumers resolver (`docs/plans/info-producers-consumers.md`) — unchanged next initiative.
