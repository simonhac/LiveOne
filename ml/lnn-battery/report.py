#!/usr/bin/env python3
"""Generate the evaluation charts and a concise, reproducible results note."""
from __future__ import annotations

import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from forecasters.data import HORIZON, TARGETS, prepare

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out")


def cash_per_step(grid: np.ndarray, imp: np.ndarray, exp: np.ndarray) -> np.ndarray:
    return (np.clip(grid, 0, None) * imp - np.clip(-grid, 0, None) * exp) / 100.0


def forecast_examples(data, forecasts) -> None:
    origins = forecasts["origins"]
    truth = forecasts["truth"]
    raw_index = data.frame.index
    local = raw_index[origins] + pd.Timedelta(hours=10)
    midnight_rows = np.flatnonzero((local.hour == 0) & (local.minute == 0))
    if len(midnight_rows) < 3:
        midnight_rows = np.linspace(0, len(origins) - 1, 3, dtype=int)

    # Choose days with the largest price spike, largest solar total, and lowest nonzero solar total.
    price_peak = truth[midnight_rows, :, TARGETS.index("import_c")].max(axis=1)
    solar_total = truth[midnight_rows, :, TARGETS.index("solar_kwh")].sum(axis=1)
    spike = int(midnight_rows[int(np.argmax(price_peak))])
    remaining = midnight_rows[midnight_rows != spike]
    sunny = int(remaining[np.argmax(solar_total[np.isin(midnight_rows, remaining)])])
    remaining = remaining[remaining != sunny]
    weekend = (local[remaining].dayofweek >= 5)
    cloudy_pool = remaining[weekend] if weekend.any() else remaining
    cloudy_solar = truth[cloudy_pool, :, TARGETS.index("solar_kwh")].sum(axis=1)
    cloudy = int(cloudy_pool[np.argmin(np.where(cloudy_solar > 0, cloudy_solar, np.inf))])
    choices = [spike, sunny, cloudy]
    labels = ("price-spike day", "high-solar day", "cloudy weekend")
    fig, axes = plt.subplots(2, 3, figsize=(15, 7), sharex="col")
    for col, (row, label) in enumerate(zip(choices, labels)):
        i = int(origins[row])
        ts = raw_index[i + 1:i + 1 + HORIZON] + pd.Timedelta(hours=10)
        for model, style in (("cfc", "-"), ("seasonal_day", "--")):
            pred = forecasts[f"pred_{model}"][row]
            axes[0, col].plot(ts, pred[:, 2], style, label=model)
            axes[1, col].plot(ts, pred[:, 1] - pred[:, 0], style, label=model)
        axes[0, col].plot(ts, truth[row, :, 2], color="black", linewidth=1.5, label="actual")
        axes[1, col].plot(
            ts, truth[row, :, 1] - truth[row, :, 0],
            color="black", linewidth=1.5, label="actual",
        )
        axes[0, col].set_title(f"{label}\n{ts[0].date()}")
        axes[0, col].set_ylabel("import price (c/kWh)")
        axes[1, col].set_ylabel("net load (kWh/30 min)")
        axes[1, col].tick_params(axis="x", rotation=30)
    axes[0, 0].legend(frameon=False)
    fig.suptitle("Held-out 48-hour forecasts: CfC vs same-time-yesterday")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "forecast_examples.png"), dpi=160)
    plt.close(fig)


def dispatch_charts(data, forecasts, dispatch, daily) -> None:
    origins = dispatch["origins"]
    ts = data.frame.index[origins] + pd.Timedelta(hours=10)
    imp = data.frame["import_c"].to_numpy()[origins]
    exp = data.frame["export_c"].to_numpy()[origins]
    scenarios = {
        "no battery": dispatch["no_battery_grid"],
        "actual": dispatch["actual_grid"],
        "seasonal-day": dispatch["seasonal_day_grid"],
        "CfC": dispatch["cfc_grid"],
        "oracle": dispatch["oracle_grid"],
    }

    fig, ax = plt.subplots(figsize=(12, 5))
    for name, grid in scenarios.items():
        ax.plot(ts, np.cumsum(cash_per_step(grid, imp, exp)), label=name)
    ax.set_title("Held-out cumulative realised cash cost")
    ax.set_ylabel("$")
    ax.set_xlabel("local date (fixed AEST/NEM convention)")
    ax.legend(ncol=3, frameon=False)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "cumulative_cost.png"), dpi=160)
    plt.close(fig)

    # Representative week: the week with the largest actual-to-oracle cash gap.
    actual_step = cash_per_step(dispatch["actual_grid"], imp, exp)
    oracle_step = cash_per_step(dispatch["oracle_grid"], imp, exp)
    width = min(7 * 48, len(ts))
    rolling_gap = np.convolve(actual_step - oracle_step, np.ones(width), mode="valid")
    start = int(np.argmax(rolling_gap))
    sl = slice(start, start + width)
    fig, ax = plt.subplots(figsize=(12, 5))
    for name, key in (
        ("actual proxy", "actual_soc"),
        ("seasonal-day", "seasonal_day_soc"),
        ("CfC", "cfc_soc"),
        ("oracle", "oracle_soc"),
    ):
        ax.plot(ts[sl], dispatch[key][sl], label=name)
    ax.set_title("Battery state during the highest-headroom held-out week")
    ax.set_ylabel("stored energy (kWh)")
    ax.legend(ncol=4, frameon=False, loc="upper center")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "soc_week.png"), dpi=160)
    plt.close(fig)

    ordered = ["no_battery", "self_consump", "actual", "seasonal_day", "cfc", "oracle"]
    totals = daily[ordered].sum()
    fig, ax = plt.subplots(figsize=(10, 5))
    colors = ["#9aa0a6", "#5f9ea0", "#3b82f6", "#f59e0b", "#8b5cf6", "#16a34a"]
    bars = ax.bar(["no battery", "self-consume", "actual", "seasonal", "CfC", "oracle"],
                  totals.values, color=colors)
    ax.bar_label(bars, labels=[f"${x:.0f}" for x in totals], padding=3)
    ax.set_title("Held-out cost comparison")
    ax.set_ylabel("$ (lower is better)")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "cost_waterfall.png"), dpi=160)
    plt.close(fig)

    # Forecast error -> daily opportunity-cost gap.
    truth = forecasts["truth"]
    origin_days = data.frame["local_day"].to_numpy()[forecasts["origins"]]
    fig, ax = plt.subplots(figsize=(8, 5))
    for name, color in (("cfc", "#8b5cf6"), ("seasonal_day", "#f59e0b")):
        mae = np.mean(np.abs(forecasts[f"pred_{name}"][:, :, 2] - truth[:, :, 2]), axis=1)
        mae_day = pd.Series(mae, index=origin_days).groupby(level=0).mean()
        gap = daily[name] - daily["oracle"]
        joined = pd.concat([mae_day.rename("mae"), gap.rename("gap")], axis=1).dropna()
        ax.scatter(joined["mae"], joined["gap"], alpha=0.7, label=name, color=color)
    ax.set_title("Price-forecast error versus cost gap to oracle")
    ax.set_xlabel("daily mean 48h import-price MAE (c/kWh)")
    ax.set_ylabel("daily cost gap ($)")
    ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "forecast_error_cost_gap.png"), dpi=160)
    plt.close(fig)


def bootstrap_ci(values: np.ndarray, seed: int = 7) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    draws = rng.choice(values, size=(10_000, len(values)), replace=True).mean(axis=1)
    return tuple(np.quantile(draws, [0.025, 0.975]))


def write_results(data, metrics: pd.DataFrame, daily: pd.DataFrame, summary: pd.DataFrame,
                  full_daily: pd.DataFrame | None = None) -> None:
    forecast_table = metrics.pivot(index="model", columns="target", values="mase").round(3)
    order = [x for x in ["oracle", "cfc", "gru", "lstm", "seasonal_day",
                         "seasonal_week", "persistence", "actual", "self_consump",
                         "no_battery"] if x in summary.index]
    cost_columns = ["cost_dollars", "savings_vs_actual_dollars"]
    if "curtailed_kwh" in summary:
        cost_columns.append("curtailed_kwh")
    cost_table = summary.loc[order, cost_columns].round(2)
    full_section = ""
    if full_daily is not None:
        full_order = [x for x in ["no_battery", "actual", "self_consump", "oracle",
                                  "mpc_persistence", "mpc_seasonal"] if x in full_daily]
        full_totals = full_daily[full_order].sum().round(2).rename("cost_dollars").to_frame()
        full_section = f"""
## Full-window reference scenarios

{full_totals.to_markdown()}

The recorded battery's full-window value versus no battery is
${full_totals.loc["no_battery", "cost_dollars"] - full_totals.loc["actual", "cost_dollars"]:.2f};
the perfect-forecast headroom versus actual is
${full_totals.loc["actual", "cost_dollars"] - full_totals.loc["oracle", "cost_dollars"]:.2f}.
"""
    ci_lines = []
    for model in ("cfc", "seasonal_day", "oracle"):
        savings = (daily["actual"] - daily[model]).to_numpy()
        lo, hi = bootstrap_ci(savings)
        ci_lines.append(
            f"- `{model}`: mean ${savings.mean():+.2f}/day "
            f"(95% day-bootstrap CI ${lo:+.2f} to ${hi:+.2f})"
        )
    marginal = (daily["seasonal_day"] - daily["cfc"]).to_numpy()
    marginal_lo, marginal_hi = bootstrap_ci(marginal)
    ci_lines.append(
        f"- `cfc vs seasonal_day`: mean ${marginal.mean():+.2f}/day "
        f"(95% day-bootstrap CI ${marginal_lo:+.2f} to ${marginal_hi:+.2f})"
    )

    cfccost = summary.loc["cfc", "cost_dollars"]
    seasoncost = summary.loc["seasonal_day", "cost_dollars"]
    actual = summary.loc["actual", "cost_dollars"]
    oracle = summary.loc["oracle", "cost_dollars"]
    neural_costs = summary.loc[["cfc", "gru", "lstm"], "cost_dollars"]
    best_neural = neural_costs.idxmin()
    conclusion = (
        f"CfC costs ${cfccost:.2f} on the held-out window versus ${seasoncost:.2f} for the "
        f"same-time-yesterday optimiser, ${actual:.2f} for the recorded battery, and ${oracle:.2f} "
        "for perfect forecasts. "
    )
    if cfccost < seasoncost:
        conclusion += f"Its marginal value over the cheap forecast is ${seasoncost-cfccost:.2f}."
    else:
        conclusion += (
            f"It does not beat the cheap forecast: its marginal value is ${seasoncost-cfccost:.2f}."
        )
    if best_neural != "cfc":
        conclusion += (
            f" The parameter-matched {best_neural.upper()} is the best neural control at "
            f"${neural_costs[best_neural]:.2f}, so the result does not support a CfC-specific advantage."
        )
    coverage_start = data.frame.index.min()
    coverage_end = data.frame.index.max()
    heldout_start = data.frame.index[data.test_origins[0]]
    heldout_end = data.frame.index[data.test_origins[-1]]

    text = f"""# Liquid neural network battery-dispatch evaluation

## Result

{conclusion}

This is an honest result on one held-out period, not evidence of general superiority. The CfC is
compared with parameter-matched GRU/LSTM controls and causal naive forecasts, and every forecast drives
exactly the same optimiser and battery model.

## Data and protocol

- The primary cash experiment uses the longest contiguous complete physical + settled-price run:
  {coverage_start} to {coverage_end} ({len(data.frame):,} half-hour intervals).
- The former April–June Amber gap in the dev mirror has been filled; no price intervals are synthesized.
- 96-hour input window, direct 48-hour forecast, 30-minute cadence.
- Chronological 60/20/20 split with a one-week purge/embargo. Neural held-out origins:
  {heldout_start} to {heldout_end}.
- Measured battery SoC gaps use the offline `stored_kwh` reconstruction; no serving-store writes.
- CfC uses the reference `ncps` implementation. GRU/LSTM parameter counts are matched to it.

## Forecast MASE

{forecast_table.to_markdown()}

## Held-out dispatch cash

{cost_table.to_markdown()}
{full_section}

## Daily savings uncertainty

{chr(10).join(ci_lines)}

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
"""
    with open(os.path.join(HERE, "RESULTS.md"), "w") as f:
        f.write(text)


def run() -> None:
    data = prepare()
    forecasts = np.load(os.path.join(OUT, "forecast_predictions.npz"), allow_pickle=False)
    dispatch = np.load(os.path.join(OUT, "dispatch_results.npz"), allow_pickle=False)
    metrics = pd.read_csv(os.path.join(OUT, "forecast_metrics.csv"))
    daily = pd.read_csv(os.path.join(OUT, "dispatch_daily.csv"), index_col=0)
    summary = pd.read_csv(os.path.join(OUT, "dispatch_summary.csv"), index_col=0)
    full_path = os.path.join(OUT, "backtest_daily.csv")
    full_daily = pd.read_csv(full_path, index_col=0) if os.path.exists(full_path) else None
    forecast_examples(data, forecasts)
    dispatch_charts(data, forecasts, dispatch, daily)
    write_results(data, metrics, daily, summary, full_daily)
    print("wrote RESULTS.md and five charts in out/")


if __name__ == "__main__":
    run()
