#!/usr/bin/env python3
"""Heroic counterfactual: CfC with perfectly accurate settled prices for the next 24 hours."""
from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

from common import load
from forecast_backtest import daily_cost, simulate
from forecasters.data import TARGETS, prepare

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out")
PREDICTIONS = os.path.join(OUT, "forecast_predictions.npz")
PRICE_STEPS = 48  # 24 hours including the observed current 30-minute planning interval


def battery_export(result: dict, netload: np.ndarray) -> np.ndarray:
    """Export caused by discharge beyond the no-battery flow after the policy's curtailment."""
    base = netload + result["curtail"]
    incremental = np.maximum(0.0, -result["grid"]) - np.maximum(0.0, -base)
    return np.maximum(0.0, incremental)


def run(resume: bool = False) -> None:
    data = prepare()
    _, pbd = load()
    saved = np.load(PREDICTIONS, allow_pickle=False)
    origins = saved["origins"]
    if not np.array_equal(origins, data.test_origins):
        raise RuntimeError("saved forecasts do not match the current data split")

    frame = data.frame
    raw = frame.loc[:, TARGETS].to_numpy(dtype=float)
    train_raw = raw[:int(len(raw) * 0.60)]
    low, high = train_raw.min(axis=0), train_raw.max(axis=0)
    low[:2] = 0.0
    cfc = saved["pred_cfc"].copy()
    saved.close()

    specs = {
        # The original controller's 48-hour planning horizon: exact prices for its first 24 hours,
        # followed by the CfC's price forecast for the remaining 24 hours.
        "cfc_exclusive": {},
        "cfc_perfect_price_24h": {"perfect_price_steps": PRICE_STEPS},
        # A pure SmartShift-like 24-hour plan: the perfect-price scenario covers the entire horizon.
        "cfc_plan_24h": {"planning_steps": PRICE_STEPS},
        "cfc_perfect_price_plan_24h": {
            "perfect_price_steps": PRICE_STEPS,
            "planning_steps": PRICE_STEPS,
        },
    }
    scenarios = {}
    cached_path = os.path.join(OUT, "price_forecast_scenario_results.npz")
    if resume and os.path.exists(cached_path):
        cached = np.load(cached_path, allow_pickle=False)
        if not np.array_equal(cached["origins"], origins):
            raise RuntimeError("cached scenario results do not match the current data split")
        for name in specs:
            if all(f"{name}_{field}" in cached for field in ("grid", "soc", "chg", "dis", "curtail")):
                scenarios[name] = {
                    field: cached[f"{name}_{field}"]
                    for field in ("grid", "soc", "chg", "dis", "curtail")
                }
                scenarios[name]["failures"] = 0
        cached.close()
    for name, kwargs in specs.items():
        if name in scenarios:
            continue
        print(f"rolling dispatch: {name}", flush=True)
        scenarios[name] = simulate(
            name, cfc, origins, frame, pbd, (low, high),
            exclusive_battery=True, **kwargs,
        )

    idx = origins
    days = frame["local_day"].to_numpy()[idx]
    imp = frame["import_c"].to_numpy()[idx]
    exp = frame["export_c"].to_numpy()[idx]
    netload = frame["netload_kwh"].to_numpy()[idx]
    actual_grid = frame["grid_kwh"].to_numpy()[idx]
    daily = pd.DataFrame({"actual": daily_cost(actual_grid, imp, exp, days)})
    for name, result in scenarios.items():
        daily[name] = daily_cost(result["grid"], imp, exp, days)
    daily.to_csv(os.path.join(OUT, "price_forecast_scenario_daily.csv"))

    totals = daily.sum()
    original = pd.read_csv(os.path.join(OUT, "dispatch_summary.csv"), index_col=0)
    rows = []
    for name, result in scenarios.items():
        rows.append({
            "scenario": name,
            "cost_dollars": totals[name],
            "savings_vs_actual_dollars": totals["actual"] - totals[name],
            "savings_vs_original_cfc_dollars":
                float(original.loc["cfc", "cost_dollars"]) - totals[name],
            "charged_kwh": float(result["chg"].sum()),
            "discharged_kwh": float(result["dis"].sum()),
            "battery_export_kwh": float(battery_export(result, netload).sum()),
            "curtailed_kwh": float(result["curtail"].sum()),
            "solver_failures": result["failures"],
        })
    summary = pd.DataFrame(rows).set_index("scenario")
    summary.to_csv(os.path.join(OUT, "price_forecast_scenario_summary.csv"))

    negative = np.flatnonzero(imp < 0)
    event_rows = []
    for k in negative:
        start = max(0, k - PRICE_STEPS)
        local_clock = (frame.index[idx[k]] + pd.Timedelta(hours=10)).tz_localize(None)
        event = {
            "timestamp_utc": frame.index[idx[k]],
            "timestamp_local_aest": local_clock,
            "import_c": imp[k],
        }
        for name, result in scenarios.items():
            event[f"{name}_prior_24h_discharge_kwh"] = float(result["dis"][start:k].sum())
            event[f"{name}_prior_24h_battery_export_kwh"] = float(
                battery_export(result, netload)[start:k].sum()
            )
            event[f"{name}_soc_before_kwh"] = float(
                result["soc"][k - 1] if k else frame["stored_kwh"].to_numpy()[idx[0]]
            )
            event[f"{name}_negative_step_charge_kwh"] = float(result["chg"][k])
            event[f"{name}_negative_step_grid_import_kwh"] = float(
                max(result["grid"][k], 0.0)
            )
        event_rows.append(event)
    events = pd.DataFrame(event_rows)
    events.to_csv(os.path.join(OUT, "price_forecast_negative_events.csv"), index=False)

    payload = {"origins": origins}
    for name, result in scenarios.items():
        for field in ("grid", "soc", "chg", "dis", "curtail"):
            payload[f"{name}_{field}"] = result[field]
    np.savez_compressed(os.path.join(OUT, "price_forecast_scenario_results.npz"), **payload)

    all_negative = frame.loc[frame["import_c"] < 0, "import_c"]
    print("\nPerfect 24-hour settled-price counterfactual ($; lower is better):")
    print(summary.round(3).to_string())
    print(
        f"\nHeld-out negative import-price intervals: {len(negative)} "
        f"(minimum {imp[negative].min():.3f} c/kWh)"
        if len(negative) else "\nHeld-out negative import-price intervals: 0"
    )
    print(
        f"Complete nine-month frame: {len(all_negative)} negative import-price intervals "
        f"(minimum {all_negative.min():.3f} c/kWh)"
    )
    if not events.empty:
        print("\nNegative-price event diagnostics:")
        print(events.to_string(index=False, float_format=lambda value: f"{value:.3f}"))
    print(
        "\nwrote out/price_forecast_scenario_{daily.csv,summary.csv,results.npz} "
        "and out/price_forecast_negative_events.csv"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--resume", action="store_true",
        help="reuse compatible cached trajectories and solve only missing scenarios",
    )
    run(parser.parse_args().resume)
