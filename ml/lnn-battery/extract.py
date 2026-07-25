#!/usr/bin/env python3
"""
extract.py — pull the confirmed Kinkora (Area 8) timeseries from the liveone-dev mirror into Parquet.

READ-ONLY. Mirrors scripts/openelectricity/publication-lag.py's psql --csv access (no psycopg dep).
Resolves each point's (system_id, point_id) from point_info by (system, logical_path_stem, metric_type)
so it self-verifies against the live schema rather than trusting hard-coded indices.

Outputs (ml/lnn-battery/data/):
  kinkora_5min.parquet        wide 5-min series (interval_end UTC index) + derived solar/load/SoC-proxy
  kinkora_params_daily.parquet  per-local-day learned battery params (capacity, eta, charge_eff, idle, floor)

See README.md for the full data map. The default starts at the first clean Amber-priced interval and
ends after the current UTC day; downstream preparation selects the longest contiguous complete run.
"""
from __future__ import annotations
import argparse, io, os, re, subprocess, sys
from datetime import datetime, timedelta, timezone
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
AREA_HANDLE = 8  # Kinkora Unified
AEST_OFFSET_H = 10  # fixed local-day offset for merging area-local daily params (matches Amber/provenance)

# name -> (system_id, logical_path_stem, metric_type, agg_col). Resolved to point_id at runtime.
SERIES_SPEC = [
    ("solar_local_w",  6, "source.solar.local",   "power",         "avg"),
    ("solar_remote_w", 6, "source.solar.remote",  "power",         "avg"),
    ("batt_power_w",   6, "bidi.battery",          "power",         "avg"),   # + discharge / - charge
    ("grid_power_w",   6, "bidi.grid",             "power",         "avg"),   # + import / - export
    ("soc_pct_meas",   5, "bidi.battery",          "soc",           "avg"),   # measured SoC% (7-month gap)
    ("stored_kwh",    15, "bidi.battery",          "stored-energy", "avg"),   # derived, continuous SoC proxy
    ("amber_import_c", 9, "bidi.grid.import",      "rate",          "avg"),   # c/kWh, 30-min native
    ("amber_export_c", 9, "bidi.grid.export",      "rate",          "avg"),   # c/kWh, 30-min native
    # Amber's OWN billed cash + metered energy on the E1/B1 meter — the realised-cash ground truth.
    ("amber_import_val_c", 9, "bidi.grid.import",  "value",         "avg"),   # cents billed / 30-min interval
    ("amber_export_val_c", 9, "bidi.grid.export",  "value",         "avg"),   # cents credited / 30-min interval
    ("amber_import_wh_m",  9, "bidi.grid.import",  "energy",        "delta"), # Amber-meter import Wh / interval
    ("amber_export_wh_m",  9, "bidi.grid.export",  "energy",        "delta"), # Amber-meter export Wh / interval
    ("oe_intensity",  12, "grid.emissionsIntensity","intensity",    "avg"),   # tCO2e/MWh (*1000 -> gCO2/kWh)
]
# Sanity-check expectations from the 2026-07-25 confirmation (warn on drift, do not fail).
EXPECTED_PID = {
    "solar_local_w": (6, 17), "solar_remote_w": (6, 7), "batt_power_w": (6, 9),
    "grid_power_w": (6, 13), "soc_pct_meas": (5, 7), "stored_kwh": (15, 6),
    "amber_import_c": (9, 2), "amber_export_c": (9, 1),
    "amber_import_val_c": (9, 7), "amber_export_val_c": (9, 5),
    "amber_import_wh_m": (9, 8), "amber_export_wh_m": (9, 6),
}


def db_url() -> str:
    override = os.environ.get("PG_EXTRACT_DB_URL")
    if override:
        return override
    path = os.path.join(ROOT, ".env.local")
    for line in open(path):
        m = re.match(r"^PLANETSCALE_DATABASE_URL=(.*)$", line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    sys.exit("no PLANETSCALE_DATABASE_URL in .env.local and no PG_EXTRACT_DB_URL")


def normalize_ssl(url: str) -> str:
    url = re.sub(r"[?&]sslmode=[^&]*", "", url)
    url = re.sub(r"[?&]sslrootcert=[^&]*", "", url)
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}sslmode=verify-full&sslrootcert=system"


def psql_df(url: str, sql: str) -> pd.DataFrame:
    out = subprocess.run(
        ["psql", normalize_ssl(url), "--csv", "-c", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"psql failed:\n{out.stderr}")
    return pd.read_csv(io.StringIO(out.stdout))


def resolve_points(url: str) -> dict[str, tuple[int, int]]:
    tuples = ",".join(f"({s},'{stem}','{m}')" for _, s, stem, m, _ in SERIES_SPEC)
    df = psql_df(url, f"""
        SELECT system_id, id AS point_id, logical_path_stem AS stem, metric_type AS metric, transform
        FROM point_info
        WHERE (system_id, logical_path_stem, metric_type) IN ({tuples});
    """)
    by_key = {(int(r.system_id), r.stem, r.metric): (int(r.system_id), int(r.point_id), r.transform)
              for r in df.itertuples()}
    resolved: dict[str, tuple[int, int]] = {}
    print("Resolved points:")
    for name, s, stem, m, _ in SERIES_SPEC:
        hit = by_key.get((s, stem, m))
        if hit is None:
            print(f"  ! {name:16s} ({s},{stem},{m}) NOT FOUND — skipping")
            continue
        sysid, pid, xform = hit
        resolved[name] = (sysid, pid)
        exp = EXPECTED_PID.get(name)
        flag = ""
        if exp and exp != (sysid, pid):
            flag = f"  <-- DRIFT (expected {exp})"
        xf = f" transform={xform}" if xform else ""
        print(f"  . {name:16s} -> {sysid}.{pid}{xf}{flag}")
    return resolved


def pull_series(url: str, resolved: dict[str, tuple[int, int]], start: str, end: str) -> pd.DataFrame:
    pairs = ",".join(f"({s},{p})" for s, p in resolved.values())
    df = psql_df(url, f"""
        SELECT system_id, point_id, interval_end, avg, delta, data_quality
        FROM point_readings_agg_5m
        WHERE (system_id, point_id) IN ({pairs})
          AND interval_end >= '{start}' AND interval_end < '{end}'
        ORDER BY interval_end;
    """)
    df["interval_end"] = pd.to_datetime(df["interval_end"], utc=True)
    name_of = {(s, p): name for name, (s, p) in resolved.items()}
    aggcol_of = {name: agg for name, _, _, _, agg in SERIES_SPEC}
    df["series"] = list(zip(df.system_id.astype(int), df.point_id.astype(int)))
    df["series"] = df["series"].map(name_of)
    # pick the right aggregate column per series (avg for level/rate, delta for interval-energy)
    use_delta = df["series"].map(aggcol_of).eq("delta")
    df["val"] = df["avg"].where(~use_delta, df["delta"])
    wide = df.pivot_table(index="interval_end", columns="series", values="val", aggfunc="last")
    # keep amber data_quality alongside (settled vs provisional)
    dq = df[df.series == "amber_import_c"].set_index("interval_end")["data_quality"].rename("amber_dq")
    wide = wide.join(dq)
    wide = wide.sort_index()
    return wide


def pull_params(url: str, start: str, end: str) -> pd.DataFrame:
    df = psql_df(url, f"""
        SELECT bpd.day, bpd.capacity_kwh, bpd.eta, bpd.charge_eff, bpd.idle_loss_kwh_day,
               bpd.reserve_floor_pct, bpd.soc_samples, bpd.charge_kwh, bpd.discharge_kwh
        FROM battery_provenance_daily bpd JOIN areas a ON a.id = bpd.area_id
        WHERE a.legacy_system_id = {AREA_HANDLE} AND bpd.day >= '{start[:10]}' AND bpd.day < '{end[:10]}'
        ORDER BY bpd.day;
    """)
    return df


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-10-19")
    tomorrow = datetime.now(timezone.utc).date() + timedelta(days=1)
    ap.add_argument("--end", default=tomorrow.isoformat(), help="exclusive UTC end (default: tomorrow)")
    args = ap.parse_args()
    os.makedirs(DATA_DIR, exist_ok=True)
    url = db_url()
    host = re.sub(r"^.*@", "", normalize_ssl(url)).split("/")[0]
    print(f"DB host: {host}   window: {args.start} .. {args.end}\n")

    resolved = resolve_points(url)
    wide = pull_series(url, resolved, args.start, args.end)

    # --- derived quantities ---
    wide["solar_w"] = wide.get("solar_local_w", 0).fillna(0) + wide.get("solar_remote_w", 0).fillna(0)
    # energy balance: load = solar + grid(+import/-export) + battery(+discharge/-charge)
    wide["load_w"] = wide["solar_w"] + wide["grid_power_w"] + wide["batt_power_w"]
    wide["netload_w"] = wide["grid_power_w"] + wide["batt_power_w"]  # = load - solar (exogenous driver)
    if "oe_intensity" in wide:
        wide["oe_gco2_kwh"] = wide["oe_intensity"] * 1000.0
    # Amber meter energy Wh -> kWh; Amber's own billed net cash (cents) = import value - export credit.
    for c in ["amber_import_wh_m", "amber_export_wh_m"]:
        if c in wide:
            wide[c.replace("_wh_m", "_kwh_m")] = wide[c] / 1000.0
    if "amber_import_val_c" in wide and "amber_export_val_c" in wide:
        wide["amber_billed_net_c"] = wide["amber_import_val_c"].fillna(0) - wide["amber_export_val_c"].fillna(0)

    # --- SoC proxy from derived stored-energy (kWh) / per-day capacity ---
    params = pull_params(url, args.start, args.end)
    params["day"] = params["day"].astype(str)
    cap_by_day = params.set_index("day")["capacity_kwh"].to_dict()
    local_day = (wide.index + pd.Timedelta(hours=AEST_OFFSET_H)).strftime("%Y-%m-%d")
    caps = pd.Series(local_day, index=wide.index).map(cap_by_day)
    wide["capacity_kwh"] = caps.values
    wide["soc_pct_proxy"] = (wide["stored_kwh"] / wide["capacity_kwh"] * 100.0).clip(0, 100)
    # best SoC estimate: measured where present, else proxy; flag synthetic spans
    wide["soc_is_synthetic"] = wide["soc_pct_meas"].isna()
    wide["soc_pct"] = wide["soc_pct_meas"].where(~wide["soc_is_synthetic"], wide["soc_pct_proxy"])

    # --- write + summarise ---
    out5 = os.path.join(DATA_DIR, "kinkora_5min.parquet")
    outp = os.path.join(DATA_DIR, "kinkora_params_daily.parquet")
    wide.to_parquet(out5)
    params.to_parquet(outp)

    n = len(wide)
    print(f"\nWrote {out5}  ({n} 5-min rows, {wide.index.min()} .. {wide.index.max()})")
    print(f"Wrote {outp}  ({len(params)} daily param rows)\n")
    print("Coverage (non-null %) and range:")
    for col in ["solar_w", "load_w", "batt_power_w", "grid_power_w", "soc_pct_meas",
                "soc_pct_proxy", "soc_pct", "amber_import_c", "amber_export_c",
                "amber_import_kwh_m", "amber_export_kwh_m", "amber_billed_net_c", "oe_gco2_kwh"]:
        if col not in wide:
            continue
        s = wide[col]
        cov = 100.0 * s.notna().mean()
        rng = f"[{s.min():.1f}, {s.max():.1f}]" if s.notna().any() else "[-]"
        print(f"  {col:16s} {cov:5.1f}%   {rng}")
    settled = wide["amber_dq"].isin(["b", "a"]).mean() * 100 if "amber_dq" in wide else 0
    print(f"\n  amber settled (b/a): {settled:.1f}% of amber rows")
    print(f"  soc synthetic (proxy used): {100*wide['soc_is_synthetic'].mean():.1f}% of rows")


if __name__ == "__main__":
    main()
