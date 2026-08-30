# lnn-battery — evaluating a Liquid Neural Network (CfC) on Kinkora home-battery dispatch

Offline, read-only backtest that evaluates a small **Liquid Neural Network** (CfC from `ncps`) as a
day-ahead forecaster driving a battery **dispatch cost-optimiser**, scored against the battery's *actual*
recorded behaviour. Objective: minimise realised **cost ($)**. Site: **Kinkora, Area 8**. No live control,
no schema changes, no writes — it reads the `liveone-dev` mirror and emits charts.

See [`PAPER.md`](PAPER.md) for the academic case-study paper, [`RESULTS.md`](RESULTS.md) for the
measured result, and [`PRICE_FORECAST_SCENARIO.md`](PRICE_FORECAST_SCENARIO.md) for the perfect
24-hour Amber-price counterfactual and historical solar-forecast options. This README is the
**confirmed data map**
(verified against the dev DB on 2026-07-25).
See [`NETWORK.md`](NETWORK.md) for the complete Mermaid connectivity diagram and parameter accounting.

## Confirmed data map (Kinkora = Area 8 "Kinkora Unified")

All series come from `point_readings_agg_5m` (`avg` column; interval-END, **UTC**), resolved from
`point_info` by `(system_id, logical_path_stem, metric_type)` — indices below are for reference.

| series | system.point | stem / metric | unit | notes |
|---|---|---|---|---|
| `solar_local_w`  | 6.17 | `source.solar.local` / power | W | PV array A |
| `solar_remote_w` | 6.7  | `source.solar.remote` / power | W | PV array B — **sum both for total solar** (~6–9 kW peak) |
| `batt_power_w`   | 6.9  | `bidi.battery` / power | W | **sign: + = discharge, − = charge** |
| `grid_power_w`   | 6.13 | `bidi.grid` / power | W | **sign: + = import, − = export** |
| `soc_pct_meas`   | 5.7  | `bidi.battery` / soc | % | **7-month gap: 2025-12-03 → 2026-07-11** |
| `stored_kwh`     | 15.6 | `bidi.battery` / stored-energy | kWh | **derived, continuous** — the fold's own coulomb-counted SoC. Use as the SoC proxy through the gap. |
| `amber_import_c` | 9.2  | `bidi.grid.import` / rate | c/kWh | 30-min native (rows every 30 min → forward-fill to 5-min) |
| `amber_export_c` | 9.1  | `bidi.grid.export` / rate | c/kWh | feed-in price; **can be negative** |
| `oe_emissions`   | 12.x | `grid.emissionsIntensity` / intensity | tCO2e/MWh | ×1000 → gCO2/kWh (optional CO₂ variant) |

**Derived:** `solar_w = solar_local_w + solar_remote_w`;
**`load_w = solar_w + grid_power_w + batt_power_w`** (energy balance with the signs above — verified on
day/night samples); `netLoad_w = load_w − solar_w = grid_power_w + batt_power_w` is the exogenous driver.

**Learned battery physics** (per local-day, `battery_provenance_daily`, area 8): usable
`capacity_kwh ≈ 21–34`, `charge_eff (η_c) ≈ 0.97–1.00`, `eta (round-trip) ≈ 0.85–0.93`,
`idle_loss_kwh_day ≈ 0.43–1.02`, `reserve_floor_pct ≈ 5–10`. **Max charge/discharge power is NOT stored** →
assume from observed max |batt_power_w| (~8 kW seen). The battery cycles hard and already
self-dispatches (Amber-aware) → dispatch (a) is a **strong** baseline, not a strawman.

## Coverage / windows (dev mirror, refreshed 2026-07-25)

- Battery power / solar / stored-energy: **continuous** 2025-10-03 → now.
- **Amber pricing (9.1/9.2): continuous 30-min coverage 2025-10-19 → current data on
  2026-07-25**. The former April–June dev-mirror gap has been filled. The refreshed offline extract has
  one complete run of 13,411 half-hour samples after its partial first day.
- Measured SoC (5.7): present Sep 2025 → 2025-12-03, gap, returns ~2026-07-12. The `stored_kwh` proxy
  covers the gap.
- Reconciliation: `point_readings_flow_attr_1d.cost_c` for area 8 spans 2025-10-03 → 2026-07-24.

## Known limitations

- **Amber forecast vintages are not preserved** — `agg_5m` holds only the latest value per interval
  (overwrites `f→e→a→b`), so a *historical* backtest cannot replay "the forecast Amber showed at time t".
  Forecasters (CfC + baselines) therefore predict from **settled history**; the "Amber-own forecast"
  baseline is live-only and omitted from the historical bake-off. Score price on settled intervals only.
- Counterfactual strategies assume the inverter can curtail PV freely. They prohibit export at a
  negative tariff, cap export at the observed 12.5 kW site limit, and share one 8.5 kW battery-throughput
  budget between charging and discharging. The recorded-actual baseline remains untouched, including
  the small amount it really exported at negative tariffs.
- Kinkora also has a **Tesla EV (system 10)** bound (`ev` role) plus a sub-metered `load.ev` circuit —
  a natural on-brief extension (EV charge scheduling) once the battery demo lands.

## Package layout

- `extract.py` — pull the confirmed streams → `data/kinkora_5min.parquet` + `data/kinkora_params_daily.parquet`.
- `battery_model.py` — Python port of `lib/battery-provenance/fold.ts` physics (+ parity test).
- `optimiser.py` — cvxpy LP receding-horizon dispatch, PV curtailment, tariff/export constraints.
- `forecasters/` — `baselines.py` (persistence, seasonal-naive), `cfc.py` (ncps CfC), `rnn.py` (GRU/LSTM).
- `train_forecasters.py` — chronological purge/embargo split, training, forecast metrics, saved predictions.
- `forecast_backtest.py` — identical rolling optimiser for every held-out forecast.
- `backtest.py` — full clean-window reference/baseline backtest.
- `report.py` — charts/tables + honest headline.

## Reference implementation and browser ports

The [`ncps` repository](https://github.com/mlech26l/ncps) and its 1.0.1 Python package provide PyTorch,
TensorFlow, and Keras implementations of CfC/LTC/NCP. They contain no maintained JavaScript, TypeScript,
or WebAssembly implementation. No compatible, maintained third-party JS/TS/WASM port was found during
this review. If browser inference becomes useful, the pragmatic route is exporting a single CfC step to
ONNX and running it with [`onnxruntime-web`](https://github.com/microsoft/onnxruntime/tree/main/js/web),
or hand-porting the compact CfC cell equations to TypeScript and parity-testing them against Python.

## Run (all read-only)

```bash
source ml/lnn-battery/.venv/bin/activate
pip install -r ml/lnn-battery/requirements.txt
python ml/lnn-battery/extract.py                 # → data/*.parquet
python ml/lnn-battery/reconcile.py
python ml/lnn-battery/battery_model.py --selftest
python ml/lnn-battery/backtest.py
python ml/lnn-battery/train_forecasters.py
python ml/lnn-battery/forecast_backtest.py
python ml/lnn-battery/report.py
python -m unittest discover ml/lnn-battery/tests
```
