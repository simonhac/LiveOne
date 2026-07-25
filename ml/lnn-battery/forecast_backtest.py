#!/usr/bin/env python3
"""Run every held-out forecast through the same rolling battery optimiser and score actual cash."""
from __future__ import annotations

import argparse
import os
import warnings

import numpy as np
import pandas as pd

from backtest import apply_export_controls, greedy_self_consumption
from battery_model import step
from common import DT_H, load
from forecasters.data import HORIZON, TARGETS, prepare
from optimiser import solve_dispatch

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out")
PREDICTIONS = os.path.join(OUT, "forecast_predictions.npz")


def daily_cost(grid: np.ndarray, imp: np.ndarray, exp: np.ndarray,
               days: np.ndarray) -> pd.Series:
    cents = np.clip(grid, 0, None) * imp - np.clip(-grid, 0, None) * exp
    return pd.Series(cents, index=days).groupby(level=0).sum() / 100.0


def simulate(name: str, pred: np.ndarray | None, origins: np.ndarray,
             frame: pd.DataFrame, pbd, bounds: tuple[np.ndarray, np.ndarray]) -> dict:
    raw = frame.loc[:, TARGETS].to_numpy(dtype=float)
    nl_actual = frame["netload_kwh"].to_numpy(dtype=float)
    imp_actual = frame["import_c"].to_numpy(dtype=float)
    exp_actual = frame["export_c"].to_numpy(dtype=float)
    stored = frame["stored_kwh"].to_numpy(dtype=float)
    days_all = frame["local_day"].to_numpy()
    low, high = bounds

    first = int(origins[0])
    first_soc_idx = next(i for i in range(first, len(stored)) if np.isfinite(stored[i]))
    first_p = pbd[days_all[first]]
    soc = float(np.clip(stored[first_soc_idx], first_p.floor_kwh, first_p.capacity_kwh))
    grid, states, chg_out, dis_out, curtail_out = [], [], [], [], []
    failures = 0

    for row, i in enumerate(origins):
        p = pbd[days_all[i]]
        soc = float(np.clip(soc, p.floor_kwh, p.capacity_kwh))
        if name == "oracle":
            idx = np.clip(np.arange(i, i + HORIZON), 0, len(frame) - 1)
            future = raw[idx].copy()
        else:
            if pred is None:
                raise ValueError(f"{name} has no predictions")
            # Forecast arrays target i+1..., while the first committed interval is reactive: its
            # net-load and known tariff are observed at i. Forecast skill affects the lookahead.
            future = np.vstack([raw[i], pred[row, :HORIZON - 1]])
        future = np.clip(future, low, high)
        net_h = future[:, 1] - future[:, 0]
        imp_h, exp_h = future[:, 2], future[:, 3]
        net_h[0] = nl_actual[i]
        imp_h[0], exp_h[0] = imp_actual[i], exp_actual[i]

        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                solution = solve_dispatch(
                    net_h, imp_h, exp_h, p, soc, DT_H,
                    terminal_soc=soc, solar_kwh=future[:, 0],
                )
            chg0, dis0 = float(solution["chg"][0]), float(solution["dis"][0])
            curtail0 = float(solution["curtail"][0])
        except Exception:
            failures += 1
            chg0 = dis0 = 0.0
            curtail0 = 0.0
        soc = step(soc, chg0, dis0, p, DT_H, floored=True)
        grid_i = nl_actual[i] + curtail0 + chg0 - dis0
        # Also protects the zero-action fallback if a solve ever fails.
        grid.append(float(apply_export_controls([grid_i], [exp_actual[i]])[0]))
        states.append(soc)
        chg_out.append(chg0)
        dis_out.append(dis0)
        curtail_out.append(curtail0)

    return {
        "grid": np.asarray(grid),
        "soc": np.asarray(states),
        "chg": np.asarray(chg_out),
        "dis": np.asarray(dis_out),
        "curtail": np.asarray(curtail_out),
        "failures": failures,
    }


def run(reuse_results: bool = False) -> None:
    if not os.path.exists(PREDICTIONS):
        raise SystemExit("run train_forecasters.py first")
    data = prepare()
    _, pbd = load()
    saved = np.load(PREDICTIONS, allow_pickle=False)
    origins = saved["origins"]
    if not np.array_equal(origins, data.test_origins):
        raise RuntimeError("saved forecasts do not match the current data split")

    frame = data.frame
    raw = frame.loc[:, TARGETS].to_numpy(dtype=float)
    train_raw = raw[:int(len(raw) * 0.60)]
    # Physical/rate guardrails learned from training only. This prevents an unstable neural outlier
    # becoming a fantastical optimiser price signal without peeking at held-out extrema.
    low, high = train_raw.min(axis=0), train_raw.max(axis=0)
    low[:2] = 0.0
    models = sorted(k.removeprefix("pred_") for k in saved.files if k.startswith("pred_"))

    results = {}
    cached_path = os.path.join(OUT, "dispatch_results.npz")
    if reuse_results:
        if not os.path.exists(cached_path):
            raise SystemExit("--reuse-results requested but out/dispatch_results.npz is missing")
        cached = np.load(cached_path, allow_pickle=False)
        if not np.array_equal(cached["origins"], origins):
            raise RuntimeError("cached dispatch results do not match the current data split")
        for name in ["oracle", *models]:
            results[name] = {
                field: cached[f"{name}_{field}"]
                for field in ("grid", "soc", "chg", "dis", "curtail")
            }
            results[name]["failures"] = 0
        cached.close()
    else:
        for name in ["oracle", *models]:
            print(f"rolling dispatch: {name}", flush=True)
            pred = None if name == "oracle" else saved[f"pred_{name}"]
            results[name] = simulate(name, pred, origins, frame, pbd, (low, high))

    idx = origins
    days = frame["local_day"].to_numpy()[idx]
    imp = frame["import_c"].to_numpy()[idx]
    exp = frame["export_c"].to_numpy()[idx]
    nl = frame["netload_kwh"].to_numpy()[idx]
    actual_grid = frame["grid_kwh"].to_numpy()[idx]
    stored0 = frame["stored_kwh"].to_numpy()[idx[0]]
    pday = [pbd[d] for d in days]
    no_battery_grid = apply_export_controls(nl, exp)
    self_grid, self_end, self_curtail = greedy_self_consumption(nl, pday, stored0, exp)

    daily = pd.DataFrame({
        "no_battery": daily_cost(no_battery_grid, imp, exp, days),
        "actual": daily_cost(actual_grid, imp, exp, days),
        "self_consump": daily_cost(self_grid, imp, exp, days),
    })
    for name, result in results.items():
        daily[name] = daily_cost(result["grid"], imp, exp, days)
    daily.to_csv(os.path.join(OUT, "dispatch_daily.csv"))

    totals = daily.sum().sort_values()
    summary = pd.DataFrame({
        "cost_dollars": totals,
        "savings_vs_actual_dollars": daily["actual"].sum() - totals,
    })
    end_soc = {"self_consump": self_end}
    end_soc.update({name: result["soc"][-1] for name, result in results.items()})
    summary["ending_soc_kwh"] = pd.Series(end_soc)
    summary["solver_failures"] = pd.Series({name: result["failures"] for name, result in results.items()})
    summary["curtailed_kwh"] = pd.Series(
        {
            "actual": 0.0,
            "self_consump": self_curtail,
            "no_battery": float(np.sum(no_battery_grid - nl)),
            **{name: result["curtail"].sum() for name, result in results.items()},
        }
    )
    summary.to_csv(os.path.join(OUT, "dispatch_summary.csv"))

    payload = {
        "origins": origins,
        "actual_grid": actual_grid,
        "no_battery_grid": no_battery_grid,
        "actual_soc": frame["stored_kwh"].to_numpy()[idx],
        "self_consump_grid": self_grid,
    }
    for name, result in results.items():
        for field in ("grid", "soc", "chg", "dis", "curtail"):
            payload[f"{name}_{field}"] = result[field]
    np.savez_compressed(os.path.join(OUT, "dispatch_results.npz"), **payload)

    print("\nHeld-out realised cash ($; lower is better):")
    print(summary.round(2).to_string())
    neural = [m for m in ("cfc", "gru", "lstm") if m in summary.index]
    cheap = [m for m in ("persistence", "seasonal_day", "seasonal_week") if m in summary.index]
    if neural and cheap:
        best_n = summary.loc[neural, "cost_dollars"].idxmin()
        best_b = summary.loc[cheap, "cost_dollars"].idxmin()
        margin = summary.loc[best_b, "cost_dollars"] - summary.loc[best_n, "cost_dollars"]
        print(f"\nBest neural: {best_n}; best cheap forecast: {best_b}; "
              f"neural marginal value = ${margin:+.2f}")
    print("\nwrote out/dispatch_daily.csv, out/dispatch_summary.csv, out/dispatch_results.npz")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reuse-results", action="store_true",
                    help="rebuild tables from the current cached dispatch trajectories")
    run(ap.parse_args().reuse_results)
