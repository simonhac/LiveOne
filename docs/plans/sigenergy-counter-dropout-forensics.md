# Sigenergy counter dropouts: prove the source, and keep the evidence

> **Status:** COMPLETE. The research is done, the two defects it found have shipped (#414, #416),
> and §1–§3 are all closed. Kept because the next person to see a 300 kW spike will ask the same
> questions.
>
> It began as fallout from the Sigenergy power/SoC recovery, which shipped a guard against this
> without establishing where the bad value came from. Answering that turned up two live defects
> (the flow-matrix overlay, and the itemList's unread power fields) and closed the guard's
> provenance question: the vendor sends the zeros.

## Why

`lib/vendors/sigenergy/derive-power.ts` reconstructs power for intervals the 5-minute poll missed,
from the same interval's energy (`Wh × 12`). Building it turned up a defect in the input it had to
guard against, and that guard rests on an unproven assumption.

The `statistics/energy` cumulative counters occasionally read ~0 for a single sample and recover.
Differencing turns that into `−(day total)` then `+(day total)` as *interval* energy. The pair
telescopes, so the day still reconciles to the vendor's headline total exactly — which is why
`computeDayEnergyReadings` keeps the diffs signed (clamping negatives made grid import come out 37×
high). Harmless for a total; ×12 it is a **324 kW** power spike. Prod, Kutis, 2026-08-20:

```
local   counter kWh   delta Wh   ×12 = W    measured W
19:15         26.97          0         0             0
19:20          0.00     −26970   −323640             0     <- counter dropped out
19:25         26.97     +26970   +323640             0     <- and came back
```

Deriving power is the first consumer that reads these values per-interval, so this was latent until
now. Over 2026-08-01..30 it would have fired **7 times** on intervals that were also missing a poll
— about 12× more often than independence predicts, because the live snapshot and the statistics
counters come from the same Sigenergy cloud backend and wobble together.

## What is already settled — do not re-derive

**The physical counter never reset.** The live poll archives its raw `energyflow` payload, which
carries `pvDayNrg` — the same cumulative day-energy counter, from a different endpoint. Across the
2026-08-20 glitch it reads `26.97` at 19:15:13, 19:20:12 and 19:25:12. So the zero exists **only**
in the statistics path; there was no meter reset and no real discontinuity.

**The guard works.** Tracking an unrepaid deficit per counter (a negative delta opens a debt; every
interval is distrusted until subsequent deltas repay it) took the worst |derived − measured| over
8640 intervals from 323.6 → 5.6 kW (solar), 33.2 → 5.5 kW (grid), 203.9 → 6.4 kW (battery), keeping
98–99 % of intervals. Negatives within one 0.01 kWh ULP are read as rounding, not a dropout —
without that exemption the low-volume flicker distrusted **half** of all grid intervals.

**`pickNumber` cannot invent a zero from an absent field.** It returns `null`, and a null counter
makes the differencing loop `continue` — no reading at all. We emitted deltas either side of the
dropout, which requires three present, numeric samples.

## SETTLED 2026-08-31 — and the itemList carries historical POWER

`raw=true` against prod returned the payload. At the 2026-08-20 19:20 dropout Sigenergy sent
literal numeric zeros — not a sentinel `pickNumber` coerced:

```json
{"dataTime": "20260820 19:20", "powerGeneration": 0, "powerToGrid": 0, "powerUse": -0.01,
 "esCharging": -0.01, "esDischarging": -0.01, "batSoc": 55.1, "loadPower": 2.219, ...}
```

`26.97 → 0 → 26.97` on `powerGeneration`, with `esCharging` going NEGATIVE (−0.01) — impossible for
a cumulative counter. **The vendor sends the zeros. `pickNumber` is exonerated** (§3 is still worth
doing on its own merits, but it is not implicated here).

**The bigger finding: the same `itemList` carries per-interval instantaneous POWER and SoC.**

```
pvTotalPower  loadPower  toGridPower  fromGridPower
esChargeDischargePower  esChargePower  esDischargePower  batSoc
```

We only ever read the six cumulative energy fields (`extractEnergyTotals`), so this was never seen.
The premise the power recovery was built on — "Sigenergy's cloud API serves no historical power, so
a missed poll is unrecoverable" — is **wrong**. It is in the payload we already fetch nightly.

Validated against our own measured samples for 2026-08-20 (n=268):

| itemList field | vs our measurement | median | p90 |
| --- | --- | --- | --- |
| `pvTotalPower` | `source.solar/power.avg` | **0.0 W** | 406 W |
| `batSoc` | `bidi.battery/soc.last` | **0.0 %** | 0.1 % |
| `loadPower` | `rest-of-house + ev` | 140 W | — |

`loadPower` is TOTAL load, EV included (on >2 kW EV intervals: 6850 W error against rest-of-house
alone, 57.5 W against the sum) — the same semantics as `powerUse`. There is **no EV field**, so the
EV / rest-of-house split still has to be interpolated. Everything else can come from the vendor.

### What this changes

Reading these fields is strictly better than deriving power from the energy counters:

- **Exact, not quantised.** No ±120 W from the 0.01 kWh counter resolution.
- **No counter-dropout guard needed for power.** The power fields did NOT glitch at 19:20 —
  `loadPower` 2.219 and `batSoc` 55.1 are both sane while every energy counter collapsed. They are
  independent failure domains.
- **No interpolation cap.** Fills a hole of any length, so the 15-minute limit disappears for
  everything except the EV split.
- **It would have filled the intervals the guard refused** (2026-08-20 01:30 / 05:05 / 09:50), which
  were refused precisely because the ENERGY counters were untrustworthy there.

`trustedCounters` stays necessary regardless — the energy series still need it, and the flow-matrix
defect below is the same bug in another consumer.

**DONE** — `derive-power.ts` now prefers the itemList power fields per field, marks them `good`
(a vendor record is not a derivation, and provenance lives in `session_id`), and falls back to the
counter arithmetic only where a field is absent. The EV / rest-of-house split stays `interpolated`,
because there is still no EV field.

⚠️ **Rows written before this are upgradable, and are meant to be.** The write decision is ranked
by quality (`interpolated` < `calculated` < `good`), not by presence — otherwise a `calculated` row
would block itself from ever becoming the vendor's own measurement, and prod already carries such
rows from 2026-08-31 (the 2026-08-20 manual run and the cron's 08-26..08-31). Only markers this
module writes are in the rank, so a `null` (measured) or `estimated` (another writer's) row is
never touched. Equal rank does not rewrite, so re-running stays idempotent.

To pick the existing rows up, re-run the backfill over the days that carry them once this is
deployed — they will not upgrade themselves, since the nightly window only reaches back 7 days.

## The open question (now answered — kept for the record)

**Did Sigenergy send the zero, or did we coerce one?**

Unresolved, and *unresolvable from stored data*: `pullEnergyDay` discards the `raw` field that
`getEnergyStatistics` returns on `SigenergyDayEnergy`, so the backfill session archives only a
summary (`{days:[{date,intervalsFetched,readingsWritten,…}]}`). The reconstruction above sums our
own stored deltas, which is circular.

Circumstantial evidence, both directions:

- **Vendor.** All six counters read zero in the same row. Six independent coercion accidents in one
  row is far less likely than one zero-filled placeholder row — and we pass `fulfill=false`
  precisely to ask the endpoint *not* to pad missing intervals.
- **Us.** `pickNumber` does `Number(v)` on any present value, so a non-numeric sentinel coerces:
  `Number(false)` and `Number([])` are both `0`. That is a genuine parser weakness whatever caused
  this particular row.

It matters because the answers diverge: a vendor placeholder means the guard is the fix, whereas a
coercion bug means the guard is papering over something we should fix at the parser.

## Work

### 1. Settle it — re-fetch the day

**The tooling exists.** `raw=true` on the backfill route (single day, dry-run) returns the vendor's
verbatim payload, using the credentials stored in prod Clerk — nothing needs to be in `.env.local`:

```
npm run liveone -- api "/api/cron/sigenergy-backfill?start=2026-08-20&end=2026-08-20\
  &dryRun=true&raw=true"
```

`liveone api` reaches it because `/api/cron(.*)` is public at the edge and a `lo_cli_` token
resolves to an admin context (`lib/api-auth.ts`), so `requireCronOrAdmin` accepts it. It prints the
`target:` line first — read it. Requires the route to be DEPLOYED, so this is a post-merge check
unless a preview is stood up (and see the receiver-URL trap below).

Then look at the `itemList` row for the dropout interval: a literal `0` / `"0"` is the vendor; a
`false`, `[]` or other non-numeric sentinel is `pickNumber` coercing (§3).

**The endpoint is deterministic for a settled past day — measured 2026-09-01.** Two `raw=true`
fetches of 2026-08-20, eight hours apart, returned a byte-identical 288-row `itemList`
(sha `40dbf9d5…` both times), and the 19:20 dropout is still there twelve days after it was first
recorded — `powerGeneration: 0`, `esCharging: -0.01`, with `batSoc: 55.1` and `loadPower: 2.219`
unaffected beside it.

So the endpoint serves a PERSISTED record, not a re-derivation: a fetch today does tell you what
arrived. A dropout is therefore diagnosable retrospectively, on demand, which is what §2 existed to
guarantee.

⚠️ **Do not run this on a preview deployment before checking where its writes go.**
`getObservationsReceiverUrl()` (`lib/qstash.ts`) falls through to the PRODUCTION receiver when
`NODE_ENV === "production"` — which a preview build is — unless the Preview scope sets
`NEXT_PUBLIC_APP_URL` or `OBSERVATIONS_QSTASH_RECEIVER_URL`. `dryRun=true` does not publish, so it
is safe; a non-dry run on a preview may not be.

The local alternative, `scripts/sigenergy/poll.ts --stats --start=… --end=… --raw`, needs
`SIGENERGY_USERNAME` / `SIGENERGY_PASSWORD` in `.env.local` (**not set** — the credentials live in
prod Clerk).

### 2. Keep the evidence — archive the raw statistics payload

**Largely OBVIATED by §1.** The point of archiving was to make the next dropout answerable without a
re-fetch; since a re-fetch of a settled past day returns the identical payload, on demand, there is
nothing to preserve. Do not build this on forensic grounds.

The one case it would still cover is a dropout older than the vendor's retention window — which is
**unmeasured** (see the note at the end of `docs/architecture/coverage-repair.md`), and only matters
for diagnosing an anomaly nobody looked at for months. Weigh it against the cost below if that ever
becomes a real need. The write side would be nearly free: the backfill route already stores the whole
`backfillEnergyRange` result (`response: result`), so carrying `raw` through onto
`PullEnergyDayResult` is most of it.

Measured on prod (device 13, 2026-08-20..21), and note the 7× is the rolling 7-day window
re-fetching the same days nightly:

| what | size |
| --- | --- |
| live poll session (raw `energyflow`, archived today) | 1,148 B × 288/day ≈ 330 KB/day |
| backfill session (summary only, today) | 912 B/day |
| backfill with raw `itemList` (288 rows × ~180 B × 7 days) | ≈ 360 KB/day |

| option | cost | verdict |
| --- | --- | --- |
| every day's raw | ~130 MB/yr per site | 7× redundant by construction |
| `itemList` only, envelope dropped | ~30 % less | still 7× redundant |
| **only days where `trustedCounters` found a dropout** | a few days/month at ~52 KB | the least-bad option IF it is ever needed — but see above: it probably is not |

### 3. Harden `pickNumber` — DONE

It now accepts a finite `number`, or a string that trims to one, and treats everything else as
absent. Bare `Number()` coerced things that are not measurements — `Number(false)` and `Number([])`
are `0`, `Number([7])` is `7`, `Number(" ")` is `0` — and a silent zero is indistinguishable
downstream from the site genuinely producing nothing. Same defect class as Selectronic's `|| 0`
idiom (see the raw-payload notes in
[architecture/coverage-repair.md](../architecture/coverage-repair.md)).

Not hypothetical for this payload: the live `energyflow` body carries `onGrid` (**boolean**) and
`greenSourceInfos` (**array**) beside the numeric fields, and `pickNumber` takes candidate key LISTS
spanning vendor spellings (`["pvPower", "pv_power", "solarPower"]`) — so a rename, or a reused name,
landing on one of those types is the realistic way this bites.

**Blast radius, measured before changing it:** `pickNumber` is module-private to
`sigenergy-client.ts`, so Sigenergy only. Across 3000 archived live responses and one full
statistics day (288 rows), every field it reads is a JSON number or `null`, and **none is ever a
string** — so the tightening is provably a no-op on real data. The numeric-string branch is kept
purely as insurance against a vendor that starts quoting its numbers. `Number.isFinite` also
replaces `!Number.isNaN`, since `Number("Infinity")` is not a measurement either.

## The same dropouts were corrupting the flow matrix — FIXED

Found 2026-08-31 while verifying the power recovery on prod: a live defect in daily energy and the
Sankey, independent of the power work, and worse than the chart gaps ever were.

**Fixed.** `trustedByDeficit` (`lib/aggregation/counter-deficit.ts`) is now shared by the overlay
and the Sigenergy power recovery — two guards disagreeing about one defect is how the overlay kept
a bug the other had already fixed. `FLOW_ATTR_VERSION` 7 → 8, so stored days re-materialise.

`attachEnergyOverlays` (`lib/aggregation/flow-series.ts:425-435`) already guards this — the comment
cites a previous Sigenergy incident, "−27.3 kWh then +29.3 kWh in adjacent 5-min slots, inflating
the day's load/charge/solar to ~2×" — but only for an **adjacent** pair:

```ts
if (v < 0) return null;
const prev = slots[slot - 1];
if (prev !== null && prev !== undefined && prev < 0) return null;
```

That is the same guard this work started with, and it has the same hole: **the freeze can last
several intervals, so the catch-up is not adjacent to the negative.** 2026-08-19 is the case —
`−10590` at 17:30, zeros through 17:55, `+10590` at 18:00. `prev` is 0, not negative, so the
catch-up passes and is counted as one interval's energy.

Measured against the metered daily total (`Σ` signed delta), August 2026, Kutis:

| day | metered solar | flow matrix | ratio |
| --- | --- | --- | --- |
| 2026-08-18 | 31.13 kWh | 31.10 kWh | 1.00 — no dropout, exact |
| 2026-08-20 | 26.97 kWh | 42.31 kWh | 1.57 |
| **2026-08-19** | **10.59 kWh** | **113.49 kWh** | **10.7** |

Five days in the month are affected (08-05, 08-06, 08-19, 08-20, 08-21); the other 26 agree with
the meter exactly. Clamping the negative half at zero is what does it: `Σ max(delta, 0)` for
2026-08-19 solar is 127.08 kWh against a true 10.59.

**The fix is already written.** `trustedCounters` (`lib/vendors/sigenergy/derive-power.ts`) is the
generalisation — it tracks an unrepaid deficit per counter, so a multi-interval freeze stays
distrusted until the debt is repaid, and single-ULP negatives are read as rounding rather than as
dropouts. Extract it and use it in `attachEnergyOverlays` so both consumers share one implementation
instead of two guards that disagree about the same data.

⚠️ Not a drop-in: the overlay returns `null` to fall back to power integration, which is the right
behaviour and should be kept. And any fix needs a `flow_attr_1d` recompute over the affected days —
scope it (`derivation=`), do not delete-and-reinsert every detector.

## Residual risk the guard does NOT cover

A dropout to a value still *above* the previous sample leaves both deltas positive and passes the
filter. Not observed in the month examined. Bounding it would need a per-metric capacity limit, and
`devices.config.spec` carries `solarSizeKw` / `batterySizeKwh` but nothing for grid or load — so
there is no principled ceiling available for two of the four series. Recorded here rather than
guessed at in code.
