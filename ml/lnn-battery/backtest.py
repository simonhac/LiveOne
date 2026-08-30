#!/usr/bin/env python3
"""
backtest.py — dispatch backtest.

Reference scenarios:
  no_battery       gridFlow = netload (battery idle)                     -> upper bound on cost
  actual           gridFlow = real Mondo grid (the incumbent battery)    -> reconciles to Amber billing
  self_consump     price-blind greedy: soak surplus solar, cover deficit
  oracle           rolling 48h MPC with PERFECT netload & price forecasts -> achievable lower bound

Rolling receding-horizon MPC (forecast-driven, the LNN slot):
  mpc:<forecaster> re-solve a 48h LP every 30 min using ONLY info available at t, commit the first step,
                   step the battery vs ACTUAL netload, accrue realised cost. Every simulation starts
                   from the same recorded SoC and then carries its own state continuously; there are no
                   daily gifts of incumbent battery inventory. Forecasters: persistence and seasonal
                   naive (yesterday). The CfC plugs into the same interface (Phase B).

Headline: battery value, oracle headroom over actual (the ceiling any forecaster competes for), and how
much of that ceiling cheap forecasts already capture (the denominator for the LNN's marginal value).
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from common import load, DT_H
from battery_model import BatteryParams, step
from optimiser import SITE_EXPORT_CAP_KW, solve_dispatch, realised_cost_c

H = 96  # 48h horizon at 30-min steps


def apply_export_controls(grid, export_c):
    """Curtail residual solar at negative tariffs and above the observed site export cap."""
    out = np.asarray(grid, dtype=float).copy()
    out = np.maximum(out, -SITE_EXPORT_CAP_KW * DT_H)
    out[(np.asarray(export_c) < 0) & (out < 0)] = 0.0
    return out


def greedy_self_consumption(netload, pday, soc0, export_c=None):
    K = len(netload)
    soc = float(soc0)
    grid = np.empty(K)
    for k in range(K):
        p = pday[k]
        soc = float(np.clip(soc, p.floor_kwh, p.capacity_kwh))
        emax = p.p_max_kw * DT_H
        nl = netload[k]
        if nl < 0:
            chg, dis = min(-nl, emax, max(0.0, (p.capacity_kwh - soc) / p.charge_eff)), 0.0
        else:
            chg, dis = 0.0, min(nl, emax, max(0.0, soc - p.floor_kwh))
        soc = step(soc, chg, dis, p, DT_H, floored=True)
        grid[k] = nl + chg - dis
    curtailed_kwh = 0.0
    if export_c is not None:
        controlled = apply_export_controls(grid, export_c)
        curtailed_kwh = float(np.sum(controlled - grid))
        grid = controlled
    return grid, soc, curtailed_kwh


def make_forecaster(kind, nl, solar, imp, exp):
    """Return f(i, H) -> (nl_hat, solar_hat, imp_hat, exp_hat) for the lookahead.

    Step 0 (the committed interval) is treated as reactively known — the caller overrides it with the
    actual current netload/price, mirroring how a real battery self-consumes against measured power flow.
    Forecast quality therefore affects only the anticipatory-arbitrage lookahead. All lookahead values are
    causal (persistence of the current obs, or yesterday's shape).
    """
    N = len(nl)
    def persistence(i, h):
        return (np.full(h, nl[i]), np.full(h, solar[i]), np.full(h, imp[i]), np.full(h, exp[i]))
    def seasonal(i, h):
        if i < 48:
            return persistence(i, h)
        offsets = np.arange(h)
        # Repeat the last fully observed day recursively across the 48-hour horizon.
        idx = i + offsets - 48 * np.ceil((offsets + 1) / 48).astype(int)
        idx = np.clip(idx, 0, i)
        return (nl[idx].copy(), solar[idx].copy(), imp[idx].copy(), exp[idx].copy())
    def oracle(i, h):
        idx = np.clip(np.arange(i, i + h), 0, N - 1)
        return (nl[idx].copy(), solar[idx].copy(), imp[idx].copy(), exp[idx].copy())
    return {"persistence": persistence, "seasonal": seasonal, "oracle": oracle}[kind]


def run_mpc(kind, nl, solar, imp, exp, stored, day, pday, valid):
    """Continuous rolling MPC. Initialise once from actual SoC, then carry the simulated state."""
    N = len(nl)
    fc = make_forecaster(kind, nl, solar, imp, exp)
    cost_by_day: dict[str, float] = {}
    curtailed_kwh = 0.0
    soc = None
    for i in range(N):
        d = day[i]
        p = pday[i]
        if not valid[i] or p is None:
            continue
        if soc is None:
            if np.isnan(stored[i]):
                continue
            soc = float(np.clip(stored[i], p.floor_kwh, p.capacity_kwh))
        else:
            # Capacity/reserve parameters can change between learned local-day rows.
            soc = float(np.clip(soc, p.floor_kwh, p.capacity_kwh))
        nl_h, solar_h, imp_h, exp_h = fc(i, H)
        nl_h[0], solar_h[0], imp_h[0], exp_h[0] = nl[i], solar[i], imp[i], exp[i]
        try:
            sol = solve_dispatch(
                nl_h, imp_h, exp_h, p, soc, DT_H,
                terminal_soc=soc, solar_kwh=solar_h,
            )
            chg0, dis0 = float(sol["chg"][0]), float(sol["dis"][0])
            curtail0 = float(sol["curtail"][0])
            curtailed_kwh += curtail0
        except Exception:
            chg0 = dis0 = 0.0
            curtail0 = 0.0
        soc = step(soc, chg0, dis0, p, DT_H, floored=True)
        grid_i = nl[i] + curtail0 + chg0 - dis0
        grid_i = float(apply_export_controls([grid_i], [exp[i]])[0])
        cost_by_day[d] = cost_by_day.get(d, 0.0) + realised_cost_c(np.array([grid_i]), imp[i:i+1], exp[i:i+1])
    result = pd.Series(cost_by_day) / 100.0
    result.attrs["end_soc_kwh"] = soc
    result.attrs["curtailed_kwh"] = curtailed_kwh
    return result


def run():
    g, pbd = load()

    # Keep complete, priced local days so every scenario is scored on exactly the same contiguous frame.
    complete_days, skipped = [], 0
    for dayk, gd in g.groupby("local_day"):
        # stored_kwh is only needed once to initialise the continuous simulation; requiring it on every
        # row would discard an otherwise fully scoreable day for an isolated SoC-proxy gap.
        needed = gd[["netload_kwh", "grid_kwh", "import_c", "export_c"]]
        ok = len(gd) == 48 and pbd.get(dayk) is not None and np.isfinite(needed.to_numpy()).all()
        if ok:
            complete_days.append(dayk)
        else:
            skipped += 1
    g = g[g["local_day"].isin(complete_days)].copy()

    day = g["local_day"].to_numpy()
    nl = g["netload_kwh"].to_numpy(); solar = g["solar_kwh"].to_numpy()
    imp = g["import_c"].to_numpy(); exp = g["export_c"].to_numpy()
    stored = g["stored_kwh"].to_numpy(copy=True); grid_actual = g["grid_kwh"].to_numpy()
    if not np.isfinite(stored).any():
        raise RuntimeError("no stored-energy reading available to initialise simulations")
    first_stored = int(np.flatnonzero(np.isfinite(stored))[0])
    stored[:first_stored] = stored[first_stored]
    pday = [pbd[x] for x in day]
    valid = ~(np.isnan(nl) | np.isnan(solar) | np.isnan(imp) | np.isnan(exp))

    def daily_cost(grid):
        cents = np.clip(grid, 0, None) * imp - np.clip(-grid, 0, None) * exp
        return pd.Series(cents, index=day).groupby(level=0).sum() / 100.0

    d = pd.DataFrame({
        "no_battery": daily_cost(nl),
        "actual": daily_cost(grid_actual),
        "amber_billed": pd.Series(
            g["amber_import_val_c"].fillna(0).to_numpy() - g["amber_export_val_c"].fillna(0).to_numpy(),
            index=day,
        ).groupby(level=0).sum() / 100.0,
    })
    no_battery_grid = apply_export_controls(nl, exp)
    self_grid, self_end, self_curtail = greedy_self_consumption(nl, pday, stored[0], exp)
    d["self_consump"] = daily_cost(self_grid)
    d["no_battery"] = daily_cost(no_battery_grid)

    # ---------- rolling MPC: perfect-forecast bound + cheap forecast baselines ----------
    mpc = {}
    for kind in ["oracle", "persistence", "seasonal"]:
        s = run_mpc(kind, nl, solar, imp, exp, stored, day, pday, valid)
        mpc[kind] = s.reindex(d.index)
    d["oracle"] = mpc.pop("oracle")

    tot = d.sum()
    ceil = tot["actual"] - tot["oracle"]  # oracle headroom
    ninv = int(np.sum(exp > imp))
    print(f"Backtested {len(d)} complete days (skipped {skipped}).  Price inversions: {ninv} steps\n")
    print("Totals over window ($):")
    print(d.sum().round(2).to_string())
    for k, s in mpc.items():
        print(f"mpc_{k:11s} {s.sum():8.2f}")
    print(f"\n--- Headline ($ over the {len(d)} complete-day window) ---")
    print(f"  no-battery bill ................. ${tot['no_battery']:.2f}")
    print(f"  actual battery (incumbent) ...... ${tot['actual']:.2f}   [Amber-billed ${tot['amber_billed']:.2f}, meter Δ${tot['actual']-tot['amber_billed']:+.2f}]")
    print(f"  dumb self-consumption ........... ${tot['self_consump']:.2f}")
    print(f"  oracle (perfect foresight) ...... ${tot['oracle']:.2f}")
    print(f"  Battery value (nobatt-actual) ... ${tot['no_battery']-tot['actual']:.2f}")
    print(f"  >> ORACLE HEADROOM over actual .. ${ceil:.2f}  <- ceiling any forecaster competes for")
    for k, s in mpc.items():
        cap = tot["actual"] - s.sum()
        pct = 100 * cap / ceil if abs(ceil) > 1e-9 else np.nan
        print(f"  MPC[{k}] saves vs actual ${cap:+.2f}  = {pct:.0f}% of the ceiling")
    print(f"\n  Ending simulated SoC: self-consumption {self_end:.1f} kWh; "
          + "; ".join(f"{k} {s.attrs.get('end_soc_kwh', np.nan):.1f} kWh" for k, s in mpc.items()))
    print(f"  Curtailed solar: no-battery {np.sum(no_battery_grid-nl):.1f} kWh; "
          f"self-consumption {self_curtail:.1f} kWh; "
          + "; ".join(f"{k} {s.attrs.get('curtailed_kwh', np.nan):.1f} kWh" for k, s in mpc.items()))
    print("\n  Interpretation: the CfC's marginal value is bounded by (ceiling - best cheap forecast).")

    d = d.join(pd.DataFrame({f"mpc_{k}": v for k, v in mpc.items()}))
    d.to_csv("ml/lnn-battery/out/backtest_daily.csv")
    print("\nwrote out/backtest_daily.csv")


if __name__ == "__main__":
    run()
