#!/usr/bin/env python3
"""common.py — shared data prep for the backtest: build the 30-min decision grid from the 5-min extract."""
from __future__ import annotations
import os
import numpy as np
import pandas as pd
from battery_model import BatteryParams, params_by_day

DATA = os.path.join(os.path.dirname(__file__), "data")
AEST_H = 10
DT_H = 0.5  # 30-min decision step


def load() -> tuple[pd.DataFrame, dict[str, BatteryParams]]:
    df = pd.read_parquet(os.path.join(DATA, "kinkora_5min.parquet")).sort_index()
    params = pd.read_parquet(os.path.join(DATA, "kinkora_params_daily.parquet"))
    pbd = params_by_day(params)
    h5 = 5.0 / 60.0
    df["solar_kwh"] = df["solar_w"] * h5 / 1000.0
    df["load_kwh"] = df["load_w"] * h5 / 1000.0
    df["netload_kwh"] = df["load_kwh"] - df["solar_kwh"]
    df["grid_kwh"] = df["grid_power_w"] * h5 / 1000.0  # +import / -export

    agg = {
        "netload_kwh": "sum", "solar_kwh": "sum", "load_kwh": "sum", "grid_kwh": "sum",
        "amber_import_c": "last", "amber_export_c": "last",
        "amber_import_val_c": "last", "amber_export_val_c": "last",
        "stored_kwh": "last", "soc_pct": "last",
    }
    g = df.resample("30min", label="right", closed="right").agg(agg)
    g["import_c"] = g["amber_import_c"].ffill(limit=1)
    g["export_c"] = g["amber_export_c"].ffill(limit=1)
    g["local_day"] = (g.index + pd.Timedelta(hours=AEST_H)).strftime("%Y-%m-%d")
    return g, pbd
