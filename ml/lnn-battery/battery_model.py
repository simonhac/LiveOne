#!/usr/bin/env python3
"""
battery_model.py — Python port of lib/battery-provenance/fold.ts three-term physics.

State E = deliverable stored energy (kWh, >=0), same quantity as the derived `stored_kwh` (point 15.6).
Per step of duration dt_h hours, with battery-terminal energies chg_kwh (into battery) and dis_kwh (out):

    E' = clip( E + charge_eff * chg_kwh  -  dis_kwh  -  idle_loss_kwh_day * dt_h / 24 ,  0,  capacity_kwh )

Charge carries the efficiency loss (eta_c); discharge is ~1:1; idle drains pro-rata with time (fold.ts).
For dispatch we also enforce a reserve floor (don't discharge below floor_frac * C) and a power limit.

`--selftest` re-simulates the ACTUAL battery power trace with per-day learned params, re-anchored each
local day to stored_kwh, and reports how closely it tracks the fold's own reconstruction (parity gate).
"""
from __future__ import annotations
import os
from dataclasses import dataclass
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
AEST_H = 10


@dataclass
class BatteryParams:
    capacity_kwh: float
    charge_eff: float            # eta_c (ratio)
    idle_loss_kwh_day: float
    reserve_floor_pct: float
    p_max_kw: float = 8.5        # not in schema; from observed max |batt power|

    @property
    def floor_kwh(self) -> float:
        return self.reserve_floor_pct / 100.0 * self.capacity_kwh


def step(E: float, chg_kwh: float, dis_kwh: float, p: BatteryParams, dt_h: float,
         floored: bool = False) -> float:
    """One forward step. floored=True clips to the reserve floor (dispatch); False clips to 0 (parity)."""
    idle = p.idle_loss_kwh_day * dt_h / 24.0
    E2 = E + p.charge_eff * chg_kwh - dis_kwh - idle
    lo = p.floor_kwh if floored else 0.0
    return float(np.clip(E2, lo, p.capacity_kwh))


def simulate(chg: np.ndarray, dis: np.ndarray, E0: float, p: BatteryParams, dt_h: float,
             floored: bool = False) -> np.ndarray:
    """Vectorised forward roll. Returns E after each step (len == len(chg))."""
    E = float(E0)
    out = np.empty(len(chg))
    for i in range(len(chg)):
        E = step(E, chg[i], dis[i], p, dt_h, floored)
        out[i] = E
    return out


def params_by_day(area_params: pd.DataFrame) -> dict[str, BatteryParams]:
    out: dict[str, BatteryParams] = {}
    for r in area_params.itertuples():
        if pd.isna(r.capacity_kwh) or pd.isna(r.charge_eff):
            continue
        out[str(r.day)] = BatteryParams(
            capacity_kwh=float(r.capacity_kwh),
            charge_eff=float(r.charge_eff),
            idle_loss_kwh_day=float(r.idle_loss_kwh_day or 0.0),
            reserve_floor_pct=float(r.reserve_floor_pct or 0.0),
        )
    return out


def selftest() -> None:
    df = pd.read_parquet(os.path.join(DATA, "kinkora_5min.parquet")).sort_index()
    params = pd.read_parquet(os.path.join(DATA, "kinkora_params_daily.parquet"))
    pbd = params_by_day(params)
    dt_h = 5.0 / 60.0

    df = df[df["stored_kwh"].notna() & df["batt_power_w"].notna()].copy()
    df["local_day"] = (df.index + pd.Timedelta(hours=AEST_H)).strftime("%Y-%m-%d")
    # battery-terminal energies from measured power (+discharge / -charge)
    df["chg_kwh"] = (-df["batt_power_w"]).clip(lower=0) * dt_h / 1000.0
    df["dis_kwh"] = df["batt_power_w"].clip(lower=0) * dt_h / 1000.0

    sim_err = []
    day_rows = []
    for day, g in df.groupby("local_day"):
        p = pbd.get(day)
        if p is None or len(g) < 12:
            continue
        E0 = float(g["stored_kwh"].iloc[0])          # re-anchor each day (isolate physics from drift/resets)
        E = simulate(g["chg_kwh"].to_numpy(), g["dis_kwh"].to_numpy(), E0, p, dt_h, floored=False)
        err = E - g["stored_kwh"].to_numpy()
        sim_err.append(err)
        day_rows.append((day, np.abs(err).mean(), p.capacity_kwh))

    allerr = np.concatenate(sim_err)
    mae = np.abs(allerr).mean()
    days = pd.DataFrame(day_rows, columns=["day", "mae_kwh", "cap"])
    capn = days["cap"].median()
    print(f"Parity vs fold's stored_kwh (daily re-anchor), {len(days)} days:")
    print(f"  MAE = {mae:.3f} kWh   ({100*mae/capn:.2f}% of ~{capn:.0f} kWh capacity)")
    print(f"  worst-day MAE = {days['mae_kwh'].max():.3f} kWh   median-day MAE = {days['mae_kwh'].median():.3f} kWh")
    ok = mae < 1.0
    print(f"  {'PASS' if ok else 'CHECK'}: physics {'tracks' if ok else 'DIVERGES from'} the fold reconstruction")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    else:
        print("use --selftest")
