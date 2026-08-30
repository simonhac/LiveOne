# Liquid neural network battery-dispatch evaluation

## Result

CfC costs $683.40 on the held-out window versus $654.38 for the same-time-yesterday optimiser, $691.76 for the recorded battery, and $588.35 for perfect forecasts. It does not beat the cheap forecast: its marginal value is $-29.02.

This is an honest result on one held-out period, not evidence of general superiority. The CfC is
compared with parameter-matched GRU/LSTM controls and causal naive forecasts, and every forecast drives
exactly the same optimiser and battery model.

## Data and protocol

- The primary cash experiment uses the longest contiguous complete physical + settled-price run:
  2025-10-19 14:30:00+00:00 to 2026-08-16 23:30:00+00:00 (14,467 half-hour intervals).
- The former April–June Amber gap in the dev mirror has been filled; no price intervals are synthesized.
- 96-hour input window, direct 48-hour forecast, 30-minute cadence.
- Chronological 60/20/20 split with a one-week purge/embargo. Neural held-out origins:
  2026-06-24 17:00:00+00:00 to 2026-08-14 23:30:00+00:00.
- Measured battery SoC gaps use the offline `stored_kwh` reconstruction; no serving-store writes.
- CfC uses the reference `ncps` implementation. GRU/LSTM parameter counts are matched to it.

## Forecast MASE

| model         |   export_c |   import_c |   load_kwh |   solar_kwh |
|:--------------|-----------:|-----------:|-----------:|------------:|
| cfc           |      1.242 |      1.367 |      1.838 |       1.154 |
| gru           |      1.242 |      1.391 |      1.799 |       1.116 |
| lstm          |      1.241 |      1.397 |      1.792 |       1.179 |
| persistence   |      1.36  |      2.543 |      2.489 |       1.37  |
| seasonal_day  |      1.436 |      1.439 |      2.058 |       0.453 |
| seasonal_week |      1.822 |      1.836 |      2.08  |       0.505 |

## Held-out dispatch cash

|               |   cost_dollars |   savings_vs_actual_dollars |   curtailed_kwh |
|:--------------|---------------:|----------------------------:|----------------:|
| oracle        |         588.35 |                      103.41 |            5.56 |
| cfc           |         683.4  |                        8.36 |           17    |
| gru           |         691.34 |                        0.42 |           16.71 |
| lstm          |         731.22 |                      -39.46 |            8.57 |
| seasonal_day  |         654.38 |                       37.38 |           38.17 |
| seasonal_week |         688.36 |                        3.4  |           70.94 |
| persistence   |        1064.42 |                     -372.66 |          410.07 |
| actual        |         691.76 |                        0    |            0    |
| self_consump  |         960.63 |                     -268.86 |            0    |
| no_battery    |        1068.55 |                     -376.79 |          369.72 |

## Full-window reference scenarios

|                 |   cost_dollars |
|:----------------|---------------:|
| no_battery      |        3354.51 |
| actual          |        1929    |
| self_consump    |        2421.74 |
| oracle          |        1534.53 |
| mpc_persistence |        3398.39 |
| mpc_seasonal    |        1866.11 |

The recorded battery's full-window value versus no battery is
$1425.51;
the perfect-forecast headroom versus actual is
$394.47.


## Daily savings uncertainty

- `cfc`: mean $+0.16/day (95% day-bootstrap CI $-0.75 to $+0.83)
- `seasonal_day`: mean $+0.72/day (95% day-bootstrap CI $-0.02 to $+1.50)
- `oracle`: mean $+1.99/day (95% day-bootstrap CI $+1.35 to $+2.68)
- `cfc vs seasonal_day`: mean $-0.56/day (95% day-bootstrap CI $-1.96 to $+0.41)

## Figures

- `out/forecast_examples.png` — representative forecasts.
- `out/soc_week.png` — actual/CfC/seasonal/oracle stored-energy paths.
- `out/cumulative_cost.png` — cumulative realised cash.
- `out/cost_waterfall.png` — headline scenario comparison.
- `out/forecast_error_cost_gap.png` — forecast error versus economic regret.

## Interpretation boundaries

Amber historical forecast vintages are not preserved, so there is no honest Amber-own forecast baseline.
Price inversions are scored at their realised rates, but the convex planning problem clamps forecast
export price to import price on those rare intervals. Counterfactual strategies may curtail available
solar, cannot export while the export tariff is negative, obey a 12.5 kW site export cap, and share one
8.5 kW throughput limit between charge and discharge. Recorded actual dispatch is left untouched. The
Mondo cash frame differs from Amber's meter by about $0.14/day in daily absolute terms (correlation
0.999) with negligible average bias; strategy differences are all scored consistently in the Mondo frame.
