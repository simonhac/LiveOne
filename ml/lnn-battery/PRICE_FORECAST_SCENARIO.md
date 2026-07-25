# Perfect 24-hour Amber price forecast scenario

## Result

Giving the CfC controller the next 24 hours of **perfect settled import and export prices made it
worse**, not better, on the held-out period:

| Controller | Held-out cost | Saving vs recorded actual |
|---|---:|---:|
| CfC, 48-hour plan, original price forecast | **$584.34** | **$28.94** |
| CfC, 48-hour plan, perfect prices for first 24 hours | $604.13 | $9.16 |
| CfC, 24-hour plan, original price forecast | **$586.97** | **$26.31** |
| CfC, 24-hour plan, perfect prices for entire horizon | $607.16 | $6.13 |

The primary apples-to-apples difference is therefore **-$19.79**: perfect 24-hour prices increased
cost by 3.39% relative to the physically matched 48-hour CfC baseline. The pure 24-hour controller
confirms the result, increasing cost by $20.18 (3.44%). This is not a rounding or horizon-tail effect.

Across the 48 local-day buckets, the perfect-price controller's mean marginal saving was -$0.41/day
(95% day-bootstrap interval -$0.84 to -$0.005). The interval is indicative only because battery state
couples adjacent days.

The formerly reported relaxed-LP CfC cost $583.96. Its physically exclusive equivalent costs $584.34,
only $0.39 more, so the changed inverter constraint does not explain the result.

## Scenario definition

- Historical Amber forecast vintages are unavailable. The scenario makes the deliberately heroic
  substitution that the settled import and export rates were known perfectly.
- At every 30-minute decision, the first 48 planning intervals (current interval plus 47 future
  intervals) receive exact settled prices.
- Solar and household-load forecasts remain the original held-out CfC predictions. This isolates price
  foresight; it does not quietly grant perfect weather or demand.
- The main controller retains its 48-hour horizon, using CfC price predictions beyond the perfect
  24-hour window. A second pair uses a pure 24-hour planning horizon, for which every planned price is
  perfect.
- Both matched comparisons use a binary charge/discharge mode. This prohibits physically dubious
  simultaneous charging and discharging within a half-hour, while permitting deliberate discharge or
  battery export before a negative-price interval.
- All policies are scored against realised net load and settled prices.

## Why perfect prices can lose

Perfect component forecasts do not imply a perfect joint controller. The optimiser acts on price,
solar, and load together. Replacing only price forecasts can remove accidental hedging in the original
forecast and make a deterministic controller more confident about decisions based on incorrect
solar/load paths.

The largest example occurred on 8 July, when the realised import tariff reached 685.92 c/kWh. The
perfect-price policy entered the spike with 7.64 kWh, versus 15.04 kWh for the ordinary CfC policy.
Both discharged at the inverter limit, but the perfect-price policy reached its reserve sooner as high
realised load continued. That day alone cost it an additional $4.38. The ordinary price forecast was
wrong, but in combination with the other forecast errors it had caused the controller to carry more
inventory.

Other contributors are forecast inconsistency and deterministic horizon effects. A better operational
design would use coherent scenarios for price, solar, and load, or explicitly optimise under
uncertainty, rather than assuming that improving one marginal forecast must improve realised control.

## Negative-pricing offload

The requested mechanism did activate:

- The held-out period contains only **one** negative retail import interval: 13 July 2026 at
  -1.447 c/kWh.
- During the preceding 24 hours, the perfect-price 48-hour policy discharged and exported 16.73 kWh;
  the matched CfC baseline exported none from the battery.
- Stored energy immediately before the negative interval was 14.90 kWh under perfect prices versus
  33.52 kWh in the baseline.
- The perfect-price policy then imported 4.25 kWh to charge at the inverter limit, versus 0.55 kWh in
  the baseline. Its cash revenue in that interval improved by about $0.05.
- Over a 24-hour window around the event the perfect-price policy saved $0.32, although over the wider
  48-hour window it cost $1.28 more. The offloading mechanism worked; the event was too mild and brief
  to make it valuable overall.

The complete nine-month frame contains 36 negative import intervals, with a minimum of
-13.557 c/kWh, but those heavier events occur outside the untouched neural test period. Using them for
a headline CfC result would contaminate the held-out evaluation.

## Historical solar forecasts for Melbourne

Historical causal irradiance forecasts are available and cover this experiment:

- [Open-Meteo's Previous Runs API](https://open-meteo.com/en/docs/previous-runs-api) exposes GHI, DNI,
  DHI, and panel-oriented GTI at fixed forecast lead times. A `previous_day1` value is the forecast
  issued 24 hours before its valid time.
- The archive includes BOM ACCESS-G from January 2024, so the October 2025–July 2026 Kinkora window is
  covered. This is forecast-vintage data rather than ERA5-style reanalysis.
- [BOM ACCESS-G](https://www.bom.gov.au/nwp/doc/access/docs/ACCESS-G.group3.slv.surface.shtml) itself
  produces hourly downward, direct, and diffuse shortwave-radiation fields from four model runs per day.
  Direct file access is available through the Bureau's registered-user data service.
- Solcast also supplies current forecast and historical irradiance products, but a generic
  “historical” irradiance series must not be assumed to be an archived forecast vintage. For this
  leakage-sensitive backtest, Open-Meteo's explicit fixed-lead archive is the clearer starting point.

The next clean experiment is to add ACCESS-G `previous_day1` irradiance as a causal feature, calibrate it
against measured Kinkora PV output using training data only, and rerun the same dispatch policies.

## Reproduction

```bash
source ml/lnn-battery/.venv/bin/activate
python ml/lnn-battery/price_forecast_scenario.py
```

Generated details:

- `out/price_forecast_scenario_summary.csv`
- `out/price_forecast_scenario_daily.csv`
- `out/price_forecast_negative_events.csv`
- `out/price_forecast_scenario_results.npz`
