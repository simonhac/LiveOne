#!/usr/bin/env python3
"""
reconcile.py — validate the realised-cash cost function against Amber's own billing.

Three daily cost frames (cents), all = import cost − export credit:
  B  Amber BILLED  = Σ amber_import_val_c − Σ amber_export_val_c        (ground truth)
  C  my rate×energy on AMBER's meter (9.8/9.6 kWh × 9.2/9.1 c/kWh)      (should ≈ B → formula OK)
  A  my rate×energy on the MONDO meter (grid_power_w → 30-min energy)   (the counterfactual frame)

If C≈B, the cost formula is correct. If A≈B, the Mondo and Amber meters agree, so counterfactual grid
flows priced with Amber rates give valid cash. Any A−B gap is a meter/alignment offset to note — it
cancels in strategy *differences* (all scenarios use frame A), but matters for absolute levels.
"""
from __future__ import annotations
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data", "kinkora_5min.parquet")
AEST_H = 10


def main() -> None:
    df = pd.read_parquet(DATA).sort_index()
    h = 5.0 / 60.0
    df["imp_kwh"] = df["grid_power_w"].clip(lower=0) * h / 1000.0
    df["exp_kwh"] = (-df["grid_power_w"]).clip(lower=0) * h / 1000.0

    # ---- 30-min resolution (interval-END: (t-30, t] labelled t) ----
    r = {}
    r["imp_kwh"] = df["imp_kwh"].resample("30min", label="right", closed="right").sum()
    r["exp_kwh"] = df["exp_kwh"].resample("30min", label="right", closed="right").sum()
    for c in ["amber_import_c", "amber_export_c", "amber_import_val_c", "amber_export_val_c",
              "amber_import_kwh_m", "amber_export_kwh_m"]:
        r[c] = df[c].resample("30min", label="right", closed="right").last()
    g = pd.DataFrame(r)
    g["local_day"] = (g.index + pd.Timedelta(hours=AEST_H)).strftime("%Y-%m-%d")

    # Only 30-min stamps where Amber priced the interval
    priced = g["amber_import_c"].notna() & g["amber_export_c"].notna()
    g = g[priced].copy()

    g["B_c"] = g["amber_import_val_c"].fillna(0) - g["amber_export_val_c"].fillna(0)
    g["C_c"] = (g["amber_import_kwh_m"].fillna(0) * g["amber_import_c"]
                - g["amber_export_kwh_m"].fillna(0) * g["amber_export_c"])
    g["A_c"] = g["imp_kwh"] * g["amber_import_c"] - g["exp_kwh"] * g["amber_export_c"]

    daily = g.groupby("local_day")[["A_c", "B_c", "C_c"]].sum()
    daily = daily / 100.0  # cents -> dollars
    daily.columns = ["A_mondo_$", "B_billed_$", "C_ambermeter_$"]

    print(f"Days reconciled: {len(daily)}  ({daily.index.min()} .. {daily.index.max()})\n")
    print("Totals over window ($):")
    print(daily.sum().round(2).to_string(), "\n")

    def stats(x, y, label):
        d = (daily[x] - daily[y])
        print(f"  {label:22s} corr={daily[x].corr(daily[y]):.4f}  "
              f"MAE=${d.abs().mean():.2f}/day  bias=${d.mean():+.2f}/day  "
              f"totΔ=${d.sum():+.1f}")
    print("Daily agreement:")
    stats("C_ambermeter_$", "B_billed_$", "C vs B (formula)")
    stats("A_mondo_$", "B_billed_$", "A vs B (meter+align)")

    print("\nSample fortnight (Nov 2025), $/day:")
    print(daily.loc["2025-11-10":"2025-11-23"].round(2).to_string())


if __name__ == "__main__":
    main()
