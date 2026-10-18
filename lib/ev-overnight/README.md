# EV-overnight advisor

**Status:** investigation (October 2026). Pure model, trigger, message and mock sender, back-tested on
one pilot site. **Nothing is wired to production**: no cron, no route, no stored state, no real send.

## The problem

At the pilot site (Sigenergy: solar, a home battery and an EV charger), the car is often plugged in after the
sun can no longer keep up. The home battery then feeds the car at about 7 kW and runs down to its
floor. The house then imports from the grid overnight, when it would otherwise have got through to
morning on the battery.

The advisor notices this as it starts. It works out the latest time (or home-battery SoC) at which
charging can stop and still leave enough above the floor for the house's **typical** overnight load,
until solar carries the house the next morning. It then drafts a text:

> I notice the car is charging from your home battery. It's at 83%. If you turn off car charging at
> 1:20am — or when the home battery gets to 24% — the car will have had 18 kWh and you'll still have
> enough in the battery to carry the house through to the morning sun.

"Typical" means the last **7** usable nights. A week is short enough that day length doesn't drift.
Weather forecasts are deliberately ignored.

## Files

| Path | What | Tracked? |
|---|---|---|
| `model.ts` | Night segmentation, battery calibration, typical-night profile, stop-time solver. Pure: no IO, no clock | ✅ |
| `advisor.ts` | Streaming trigger (`stepAdvisor`). Samples in, state plus at most one advice per charging session out | ✅ |
| `message.ts` | Renders the text (`renderAdvice`). `send: false` for no-action and battery-empty | ✅ |
| `notify.ts` | `TextSender` interface plus `MockTextSender`. No transport has been chosen | ✅ |
| `__tests__/` | 28 Jest tests on **synthetic** fixtures (`fixtures.ts`). No real household data in the repo | ✅ |
| `scripts/temp/ev-overnight-fetch.ts` | Downloads a site's 5-minute history and EV sessions from prod through the `liveone` CLI | ❌ gitignored |
| `scripts/temp/ev-overnight-backtest.ts` | Calibration, validation, replay, trigger × buffer sensitivity, charts and report | ❌ gitignored |
| `.context/ev-overnight/` | `data/`, `report.md` (every advised session and mock text), `charts/`, `outbox.jsonl`, `events.json` | ❌ gitignored, per-workspace |

🛑 The two scripts and all outputs live in **gitignored** paths. They vanish with the Conductor
workspace. Move the scripts somewhere tracked (e.g. `scripts/investigations/`) before relying on them
from another checkout.

## Re-running

```bash
npx jest lib/ev-overnight                          # unit tests, synthetic, no network
npx tsx scripts/temp/ev-overnight-fetch.ts --device <ref> --derivation <dx_…>   # read-only prod pull
npx tsx scripts/temp/ev-overnight-backtest.ts      # → .context/ev-overnight/report.md (+ --buffer N --days N --capacity kWh)
```

Notes on the fetch:
- It needs a prod CLI token for `https://www.liveone.energy`. The apex domain has no token
  (`liveone auth list` shows `localOrigins`).
- `--device` is the battery/EV device; `--derivation` is its EV run detector (`liveone derivation
  list`). The site is deliberately not named in this repo.
- It pulls `device history <device> --interval 5m` in windows of 31 days or less (the API cap) and
  the EV detector's sessions (`derivation intervals <dx_…>`).
- The window defaults to 2026-07-06 → 2026-10-17. Pass `--start`/`--end` to change it.

Charts are SVG, converted to PNG with Quick Look (`qlmanage`) because the local ImageMagick has no font
delegate. That step is macOS-only.

## How the model works

The *why* lives in each file's header comment. In short:

1. **Nights** run from local noon to local noon, keyed by the evening's date, in 288 five-minute
   slots by **wall clock**. House load follows the clock. On the DST night this costs at most an
   hour of overnight load (~1% SoC).
2. **Morning cover** for each night is the first slot after 03:00 where solar ≥ house load (and
   ≥ 100 W) for 15 minutes. Only this **uncurtailed morning ramp** of the solar curve is ever used.
   After the battery fills, solar is curtailed to whatever is being drawn, so it no longer measures
   available sun.
3. **Overnight need** for a night is `Σ drain(max(0, house − solar))` from each slot to that
   night's cover. The **typical need** is the *mean of each night's need* over the last 7 usable
   nights. It is not the need of the mean curve: `max(0, ·)` is non-linear, and the mean curve would
   understate a dull morning.
4. **Battery calibration** is learned, never taken from the nameplate:
   - the floor;
   - the discharge cap;
   - a **quadratic drain curve**: SoC %/h = `c0 + c1·P + c2·P²`, fitted on 30-minute windows
     against SoC.
5. **Solver**: walk forward from now. The battery drains at `drain(min(cap, ev + house − solar))`
   while the car charges, and must hold `floor + buffer + typicalNeed[slot]`. The crossing, rounded
   down to five minutes, is the stop time. Other outcomes:
   - `stop-now`: already short, with the expected import;
   - `no-action`: it lasts all night;
   - `battery-empty`: already at the floor, so nothing is sent.
6. **Trigger** (default `battery-feeding-car`): the car is charging (≥ 1.5 kW) and the battery is
   discharging (≥ 1 kW) for 2 consecutive samples, inside 15:00–04:00 local. It fires once per
   charging session. A session ends after 15 minutes below 100 W, so a second plug-in the same night
   is advised again.

## Pilot-site findings (back-test, 2026-07-06 → 2026-10-17)

The data: 29,952 five-minute samples and 57 EV sessions.

### Battery, as learned from the data

| | |
|---|---|
| Floor | **10%**. It sits there all night once empty |
| Discharge cap | **10 kW**. With the car (~6.8 kW) plus cooking, the grid tops up even above the floor |
| Drain curve | `0.593 + 2.831·P + 0.0566·P²` %/h (P in kW), from 1,355 windows. RMSE 0.31% per 30 minutes; bias +0.05% (EV) / −0.00% (no EV) |
| Effective kWh per % | 0.21 at 0.3 kW · 0.29 at 1 kW · 0.30 at 7 kW · 0.29 at 10 kW. The nameplate capacity implies ~0.32, which is wrong in both regimes |

The ~0.6 %/h intercept is about 200 W of standby the power readings never show. Two things contribute:
Sigenergy rounds power to 0.1 kW, and an overnight house reading "200 W" drains the battery like
~400 W.

### Validation on EV-free nights (SoC at 21:05 → SoC at morning cover)

59 nights. The error is actual − predicted SoC %; negative means the battery ended lower than assumed,
which is the risky side.

| Predictor | Mean | p10 | p90 | Worst |
|---|---|---|---|---|
| Typical night (mean of last 7) | +1.4 | −2.7 | +4.8 | −6.0 |
| Oracle (that night's own load) | +0.1 | −0.8 | +1.1 | −1.8 |

The oracle row isolates the battery model, which is good to about ±1%. Night-to-night variation is
the bigger error. The typical night understated the need by more than 3% on 7% of nights, by more
than 5% on 2%, and by more than 8% on none. **That is why the buffer is 5%.**

Seven nights were excluded because the battery **exported ~5 kW to the grid in the dark** for up to
2 hours before dawn. This is probably price-driven dispatch (Amber/Sigenergy). With those nights
included, the worst error was −30%.

### Trigger × buffer, over every advised session

"Rescued" means the battery actually ran flat, and stopping as advised would have imported under
0.5 kWh.

| Trigger | Buffer | Texts | Ran flat | Rescued | Import: actual → if stopped | Car kWh forgone | Median notice |
|---|---|---|---|---|---|---|---|
| **battery-feeding-car** | **5%** | 33 | 21 | 11 | 211 → 31 kWh | 200 | 120 min |
| battery-feeding-car | 3% | 33 | 21 | 9 | 211 → 35 | 190 | 125 min |
| battery-feeding-car | 8% | 33 | 21 | 13 | 211 → 25 | 214 | 115 min |
| sun-down (solar < 150 W) | 3% | 22 | 17 | 7 | 185 → 31 | 162 | 85 min |
| sun-down | 5% | 22 | 17 | 8 | 185 → 29 | 168 | 80 min |

"Actual" import includes the car charging from the grid after the battery hit its floor.

### The night charges that ran the battery flat (current defaults)

| Night | Text | Battery | Stop by | Car gets | Import: actual → if stopped |
|---|---|---|---|---|---|
| 26 Aug | 9:50pm | 85% | 12:15am (25%) | 18 kWh | 15.3 → 1.7 kWh |
| 28 Aug | 10:50pm | 83% | 1:20am (24%) | 18 | 23.4 → 0.0 |
| 8 Sep | 10:10pm | 86% | 12:45am (24%) | 19 | 3.4 → 0.0 |
| 17 Sep | 10:50pm | 89% | 1:40am (22%) | 20 | 12.5 → 0.0 |
| 1 Oct | 10:40pm | 55% | 12:00am (23%) | 10 | 26.8 → 0.1 |
| 3 Oct | 8:15pm | 30% | now | 0.6 | 25.0 → 0.2 |
| 16 Oct | 5:20pm | 96% | 8:05pm (31%) | 19 | 12.1 → 1.9 |

The two residual imports are atypical nights: ~4 kW of evening cooking on 16 Oct, and a big breakfast
load before the sun on 26 Aug.

The typical overnight need from 21:00 to morning cover was about 5–8 kWh in July and 4–6 kWh in
September–October. Cover moved from ~08:15 to ~07:15 (AEDT) over the period.

## Decisions taken

All of these were made with Simon during the investigation.

- **Trigger = battery feeding the car**, not "sun is down".
  - Measured solar was chosen first, over astronomical sunset: the area has no lat/lng, and dull
    evenings count.
  - The back-test overturned it. A charge started before sunset has usually halved the battery
    before solar reads ~zero: on 16 Oct the battery was feeding the car from 5:15pm at 97%, but solar
    only read ~zero at 7:20pm at 50%.
  - `sun-down` remains available as a config option.
- **Buffer = 5%** above the learned floor (see the validation above).
- **x = 7 nights**, mean of the per-night needs. No weather.
- **Floor learned from the data**, not configured. At the pilot site it comes out at 10%.
- **Energy in AC kWh, SoC from the fitted drain curve.** The nameplate capacity is never used.
- The pure core follows `lib/automations/decide.ts` (injected `nowMs`) so it can be table-tested.

## Known limitations

- **The car finishing on its own.** About a quarter of texts landed on nights where the car finished
  before the advised stop. Suppressing these needs the car's SoC and charge limit (e.g. the Tesla
  Fleet API).
- **3pm texts.** On overcast winter afternoons the battery is already feeding the car when the window
  opens at 15:00, so several texts go out at exactly 3:00pm.
- **Battery dispatch.** Night-time export to the grid can spend the reserve the text tells the user
  to keep. Production needs to read the dispatch/VPP mode or price signal, or accept this.
- **The simulator under-predicts import.** It underestimates actual grid import by ~0.5–1 kWh on
  run-down nights and hits the floor ~5–10 minutes late. Counterfactual "if stopped" imports are
  slightly optimistic.
- **The back-test calibrates on the whole history**, so it uses later data. That's fine for physical
  constants; production should learn them causally (trailing window).
- **Data quirks.** Sigenergy power has 0.1 kW resolution. SoC can read 100% while discharging (the
  calibrator excludes SoC ≥ 98 and any window where SoC rises). The `*/energy.delta` series lagged
  power by exactly an hour after DST started on 2026-10-04; a fix was in progress elsewhere at the
  time. Only power and SoC are used here.
- **One site.** It has only been tested on the pilot site, which has a clean house-load point that excludes
  the EV (`load.rest-of-house/power`). Other vendors may need `load − ev`.

## Path to production (not started)

- **Detect.** The EV run detector already exists:
  - `getOpenRun` / `isRunningNow` in `lib/run-tracking/live.ts`;
  - `publishRunningLatest` (`ev/running` in KV), refreshed minutely by `/api/cron/derivations`.
  - Feed `stepAdvisor` from KV-latest (battery power, SoC, EV power) on that tick, or evaluate inside
    the automations evaluator (`lib/automations/evaluate.ts`, which already has `charge-session`
    triggers and KV-based alert suppression).
- **Profile.** Build the 7-night profile from `agg_5m` through the readings DAO, once per night per
  device, and cache it.
- **Calibration.** Persist per device and learn it causally. `lib/battery-provenance/` already
  learns a capacity and a reserve floor, but on a different basis: kWh over 0–100% from energy.
  Check whether its floor agrees before reusing it. The drain curve is new.
- **Config per device:**
  - the trigger;
  - the buffer;
  - the window;
  - which points are house-excluding-EV, solar, SoC, battery and EV;
  - the recipient.
- **Send.** Pick a transport (SMS, push, Slack) behind `TextSender`. Dedupe on (device, session
  start), and note `decide.ts`'s warning that an open run's `start_time` moves between ticks.
- **Wording.** The opener is trigger-neutral. A cost line using Amber prices would be cheap to add.
- 🛑 **knip** will flag this whole directory as unused until something imports it. Either wire it in
  or mark it `@knipignore` with a reason.

## Open questions

- Should the text name a cost ("this would cost about $X from the grid")?
- Should there be one follow-up text when the advised stop time passes and the car is still charging?
- What should happen on dispatch nights? Suppress the text, or warn that the battery may export
  anyway?
