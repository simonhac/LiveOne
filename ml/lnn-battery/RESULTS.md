# Liquid neural network battery-dispatch evaluation

## Result

CfC costs $583.96 on the held-out window versus $590.81 for the same-time-yesterday optimiser, $613.29 for the recorded battery, and $528.78 for perfect forecasts. Its marginal value over the cheap forecast is $6.85.

This is an honest result on one held-out period, not evidence of general superiority. The CfC is
compared with parameter-matched GRU/LSTM controls and causal naive forecasts, and every forecast drives
exactly the same optimiser and battery model.

## Data and protocol

- The primary cash experiment uses the longest contiguous complete physical + settled-price run:
  2025-10-19 14:30:00+00:00 to 2026-07-25 23:30:00+00:00 (13,411 half-hour intervals).
- The former April–June Amber gap in the dev mirror has been filled; no price intervals are synthesized.
- 96-hour input window, direct 48-hour forecast, 30-minute cadence.
- Chronological 60/20/20 split with a one-week purge/embargo. Neural held-out origins:
  2026-06-07 02:30:00+00:00 to 2026-07-23 23:30:00+00:00.
- Measured battery SoC gaps use the offline `stored_kwh` reconstruction; no serving-store writes.
- CfC uses the reference `ncps` implementation. GRU/LSTM parameter counts are matched to it.

## Forecast MASE

| model         |   export_c |   import_c |   load_kwh |   solar_kwh |
|:--------------|-----------:|-----------:|-----------:|------------:|
| cfc           |      1.256 |      1.392 |      1.802 |       1.343 |
| gru           |      1.196 |      1.418 |      1.777 |       1.292 |
| lstm          |      1.245 |      1.437 |      1.764 |       1.372 |
| persistence   |      1.298 |      2.397 |      2.484 |       1.12  |
| seasonal_day  |      1.331 |      1.334 |      1.939 |       0.434 |
| seasonal_week |      1.887 |      1.903 |      2.208 |       0.525 |

## Held-out dispatch cash

|               |   cost_dollars |   savings_vs_actual_dollars |   curtailed_kwh |
|:--------------|---------------:|----------------------------:|----------------:|
| oracle        |         528.78 |                       84.5  |            0    |
| cfc           |         583.96 |                       29.33 |           15.34 |
| gru           |         620.79 |                       -7.5  |           29.16 |
| lstm          |         712    |                      -98.72 |           17.11 |
| seasonal_day  |         590.81 |                       22.48 |           41.32 |
| seasonal_week |         635.81 |                      -22.52 |           58.42 |
| persistence   |         914.67 |                     -301.39 |          347.52 |
| actual        |         613.29 |                        0    |            0    |
| self_consump  |         845.84 |                     -232.55 |            0    |
| no_battery    |         923.94 |                     -310.65 |          298.01 |

## Full-window reference scenarios

|                 |   cost_dollars |
|:----------------|---------------:|
| no_battery      |        2917.85 |
| actual          |        1646.22 |
| self_consump    |        2030.54 |
| oracle          |        1303.54 |
| mpc_persistence |        2950.69 |
| mpc_seasonal    |        1608.32 |

The recorded battery's full-window value versus no battery is
$1271.63;
the perfect-forecast headroom versus actual is
$342.68.


## Daily savings uncertainty

- `cfc`: mean $+0.61/day (95% day-bootstrap CI $+0.06 to $+1.21)
- `seasonal_day`: mean $+0.47/day (95% day-bootstrap CI $-0.23 to $+1.22)
- `oracle`: mean $+1.76/day (95% day-bootstrap CI $+1.10 to $+2.52)
- `cfc vs seasonal_day`: mean $+0.14/day (95% day-bootstrap CI $-0.41 to $+0.70)

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
Mondo cash frame differs from Amber's meter by about $0.26/day in daily absolute terms and is $0.11/day
lower on average; strategy differences are all scored consistently in the Mondo frame.
