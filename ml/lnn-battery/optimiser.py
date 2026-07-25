#!/usr/bin/env python3
"""
optimiser.py — LP battery dispatch that minimises realised grid cash over a horizon.

Decision (per 30-min step k): chg[k]>=0, dis[k]>=0 (kWh at the battery terminal),
curtail[k]>=0 (solar not exported), and soc[k] (kWh).
Exogenous: netload_kwh[k] = load-solar (battery moves grid flows only, never load/solar).
    gridFlow[k] = netload_kwh[k] + curtail[k] + chg[k] - dis[k]  (+import / -export, kWh)
    cost[k]     = max(import_price[k]*gridFlow[k],            (cents; convex, valid while
                      export_price[k]*gridFlow[k])             import_price >= export_price)

SoC dynamics mirror the fold three-term model exactly: charge efficiency on the charge leg, 1:1
discharge, and idle drain:
    soc[k+1] = soc[k] + charge_eff*chg[k] - dis[k] - idle_per_step
Bounds floor<=soc<=capacity, power chg,dis <= pmax*dt_h. A terminal value on leftover soc[K]
is deliberately NOT used in rolling MPC: rewarding the same distant inventory at every re-plan causes
the controller to fill the battery repeatedly. Instead callers use `terminal_soc` to require the
horizon to finish with at least its starting inventory. Returns the schedule.

Solar may be curtailed up to forecast production. Export is prohibited whenever its tariff is negative,
and all export is bounded by the observed Kinkora site limit. Battery throughput shares one inverter-time
budget (`chg + dis <= Pmax*dt`) so a 30-minute bucket cannot charge and discharge each at full power.
"""
from __future__ import annotations
import numpy as np
import cvxpy as cp
from battery_model import BatteryParams

SITE_EXPORT_CAP_KW = 12.5  # observed meter peak ≈12.3 kW; rounded physical site/inverter limit


def solve_dispatch(netload_kwh: np.ndarray, import_c: np.ndarray, export_c: np.ndarray,
                   p: BatteryParams, soc0: float, dt_h: float,
                   terminal_soc: float | None = None,
                   solar_kwh: np.ndarray | None = None,
                   export_cap_kw: float = SITE_EXPORT_CAP_KW,
                   exclusive_battery: bool = False) -> dict:
    K = len(netload_kwh)
    chg = cp.Variable(K, nonneg=True)
    dis = cp.Variable(K, nonneg=True)
    curtail = cp.Variable(K, nonneg=True) if solar_kwh is not None else None
    soc = cp.Variable(K + 1)
    idle = p.idle_loss_kwh_day * dt_h / 24.0
    emax = p.p_max_kw * dt_h

    grid = netload_kwh + chg - dis
    if curtail is not None:
        grid = grid + curtail
    # export price can exceed import price in rare Amber inversions → the convex `max` would misprice.
    # Clamp export to <= import per-step so the piecewise cost stays convex/physical (flagged upstream).
    exp_c = np.minimum(export_c, import_c)
    cost = cp.sum(cp.maximum(cp.multiply(import_c, grid), cp.multiply(exp_c, grid)))

    cons = [soc[0] == soc0,
            soc[1:] == soc[:-1] + p.charge_eff * chg - dis - idle,
            soc >= p.floor_kwh, soc <= p.capacity_kwh]
    if exclusive_battery:
        # Negative import prices can otherwise make simultaneous charging/discharging profitable:
        # the battery dissipates energy through charge loss while being paid for the small net import.
        # A binary inverter mode makes the alternative scenario physical and still permits deliberate
        # discharge/export before a forecast negative-price interval to create charging headroom.
        charging_mode = cp.Variable(K, boolean=True)
        cons.extend([chg <= emax * charging_mode, dis <= emax * (1 - charging_mode)])
    else:
        cons.append(chg + dis <= emax)
    if curtail is not None:
        available_solar = np.maximum(np.asarray(solar_kwh, dtype=float), 0.0)
        if len(available_solar) != K:
            raise ValueError("solar_kwh must match netload_kwh")
        cons.append(curtail <= available_solar)
        negative_export = np.asarray(export_c) < 0
        if np.any(negative_export):
            # Free inverter curtailment makes paying to export irrational; battery discharge cannot
            # push the meter back into export during these known/forecast negative-tariff intervals.
            cons.append(grid[negative_export] >= 0)
    if export_cap_kw >= 0:
        cons.append(grid >= -export_cap_kw * dt_h)
    if terminal_soc is not None:               # day-neutral: end at least where we started (no scoring distortion)
        cons.append(soc[K] >= terminal_soc)
    prob = cp.Problem(cp.Minimize(cost), cons)
    prob.solve(solver=cp.HIGHS if exclusive_battery else cp.CLARABEL)
    if prob.status not in ("optimal", "optimal_inaccurate"):
        raise RuntimeError(f"LP status {prob.status}")
    g = np.asarray(grid.value).ravel()
    return {
        "chg": np.asarray(chg.value).ravel(),
        "dis": np.asarray(dis.value).ravel(),
        "soc": np.asarray(soc.value).ravel(),
        "grid": g,
        "batt_kwh": np.asarray((chg.value - dis.value)).ravel(),  # + charge / - discharge (terminal)
        "curtail": (
            np.asarray(curtail.value).ravel() if curtail is not None else np.zeros(K, dtype=float)
        ),
        "n_inversions": int(np.sum(export_c > import_c)),
    }


def realised_cost_c(grid_kwh: np.ndarray, import_c: np.ndarray, export_c: np.ndarray) -> float:
    """Realised cash (cents) from actual grid flow priced at actual rates (Mondo frame, validated)."""
    imp = np.clip(grid_kwh, 0, None)
    exp = np.clip(-grid_kwh, 0, None)
    return float(np.sum(imp * import_c - exp * export_c))
