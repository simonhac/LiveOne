# Sigenergy counter dropouts: prove the source, and keep the evidence

> **Status:** proposed — research first, no code written (drafted 2026-08-31). Fallout from the
> Sigenergy power/SoC recovery work, which shipped a guard against this without ever establishing
> where the bad value comes from. The guard is not blocked on any of this; it rejects the interval
> on evidence the counter went backwards, which holds under either explanation.

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

## The open question

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

⚠️ Check first that the endpoint is deterministic for a settled past day. If it re-derives on read,
a fetch today says nothing about what arrived on 2026-08-21 — in which case only §2 can answer it,
for future occurrences.

⚠️ **Do not run this on a preview deployment before checking where its writes go.**
`getObservationsReceiverUrl()` (`lib/qstash.ts`) falls through to the PRODUCTION receiver when
`NODE_ENV === "production"` — which a preview build is — unless the Preview scope sets
`NEXT_PUBLIC_APP_URL` or `OBSERVATIONS_QSTASH_RECEIVER_URL`. `dryRun=true` does not publish, so it
is safe; a non-dry run on a preview may not be.

The local alternative, `scripts/sigenergy/poll.ts --stats --start=… --end=… --raw`, needs
`SIGENERGY_USERNAME` / `SIGENERGY_PASSWORD` in `.env.local` (**not set** — the credentials live in
prod Clerk).

### 2. Keep the evidence — archive the raw statistics payload

So the next occurrence is answerable without a re-fetch. The write side is nearly free: the backfill
route already stores the whole `backfillEnergyRange` result (`response: result`), so carrying `raw`
through onto `PullEnergyDayResult` is most of it.

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
| **only days where `trustedCounters` found a dropout** | a few days/month at ~52 KB | **preferred** — we already detect them, and it captures exactly the forensic case |

### 3. Harden `pickNumber` regardless

Reject non-numeric input rather than coercing it: `typeof v === "number"`, or a string that parses.
`Number(false) === 0` and `Number([]) === 0` are silent, and this is the same defect class as
Selectronic's `|| 0` idiom (see the raw-payload notes in
[architecture/coverage-repair.md](../architecture/coverage-repair.md)). Worth doing whichever way §1
lands. ⚠️ Check the blast radius first — `pickNumber` is used by every Sigenergy field, and a
vendor that legitimately sends numeric strings would start returning `null`.

## Residual risk the guard does NOT cover

A dropout to a value still *above* the previous sample leaves both deltas positive and passes the
filter. Not observed in the month examined. Bounding it would need a per-metric capacity limit, and
`devices.config.spec` carries `solarSizeKw` / `batterySizeKwh` but nothing for grid or load — so
there is no principled ceiling available for two of the four series. Recorded here rather than
guessed at in code.
