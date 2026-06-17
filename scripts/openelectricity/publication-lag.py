#!/usr/bin/env python3
"""
OpenElectricity publication-lag analysis — reconstructed from our OWN persisted readings.

For each OpenElectricity region system we record, on first write, `point_readings_agg_5m.created_at`
(preserved across heal-UPSERTs — the receiver's onConflict set: does NOT touch created_at). So:

    publication lag (minutes) = created_at - interval_end

is the lag, as our pipeline observed it, between an interval ending and the data first becoming
available. It very slightly OVERSTATES OpenElectricity's true publish lag by our own pipeline floor
(poll cadence + QStash + receive, ≈ the fast endpoint's typical lag of <1 min) — negligible for the
multi-minute stalls this is meant to surface. No live API polling required.

Two point series are reported:
  - point 1 = emissions intensity, derived from the `data` endpoint (power/emissions) — the laggard
  - point 2 = spot price, from the `market` endpoint — normally prompt

Outputs:
  1. a per-day summary table (median / p90 / max / %>5min) for emissions THEN price, one row per
     AEST day, to stdout;
  2. a "lag by time of day" PNG (one line per day, half-hour buckets) for the emissions/data series.

Only live rows are used (data_quality='good'); the one-off bulk backfill is excluded (its created_at
is the backfill run time, not the live publish time).

USAGE
  # dev mirror (from .env.local PLANETSCALE_DATABASE_URL) — ~2h stale:
  python3 scripts/openelectricity/publication-lag.py

  # prod (sydney) — mint a short-TTL read-only role first:
  pscale role create liveone sydney oe-lag-ro --inherited-roles pg_read_all_data --ttl 1h --format json
  PG_LAG_DB_URL="<database_url from that json>" python3 scripts/openelectricity/publication-lag.py
  # ...then clean up:  pscale role delete liveone sydney <role-id> --force

OPTIONS
  --system N   region system id (default 11 = NSW1; 12 = VIC1)
  --days N     lookback window in days (default 10)
  --db URL     connection string (else $PG_LAG_DB_URL, else PLANETSCALE_DATABASE_URL in .env.local)
  --out PATH   chart output (default .context/oe-lag-by-halfhour.png)

DEPENDENCIES: psql on PATH, Python 3, Pillow (for the chart; the table prints without it).
"""
import argparse, collections, csv, io, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def db_url_from_env_local() -> str | None:
    path = os.path.join(ROOT, ".env.local")
    if not os.path.exists(path):
        return None
    for line in open(path):
        m = re.match(r"^PLANETSCALE_DATABASE_URL=(.*)$", line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return None


def normalize_ssl(url: str) -> str:
    """Force the system trust store (psql needs a CA; psdb gateways use a public CA)."""
    url = re.sub(r"[?&]sslmode=[^&]*", "", url)
    url = re.sub(r"[?&]sslrootcert=[^&]*", "", url)
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}sslmode=verify-full&sslrootcert=system"


def psql_csv(url: str, sql: str) -> list[dict]:
    out = subprocess.run(
        ["psql", normalize_ssl(url), "-A", "-F,", "--csv", "-c", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"psql failed:\n{out.stderr}")
    return list(csv.DictReader(io.StringIO(out.stdout)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--system", type=int, default=11)
    ap.add_argument("--days", type=int, default=10)
    ap.add_argument("--db", default=None)
    ap.add_argument("--out", default=os.path.join(ROOT, ".context", "oe-lag-by-halfhour.png"))
    args = ap.parse_args()

    url = args.db or os.environ.get("PG_LAG_DB_URL") or db_url_from_env_local()
    if not url:
        sys.exit("No DB URL (pass --db, set $PG_LAG_DB_URL, or provide .env.local).")

    host = re.sub(r".*@([^/?]+).*", r"\1", url)
    where = (
        f"system_id={args.system} AND data_quality='good' "
        f"AND interval_end >= (SELECT max(interval_end) FROM point_readings_agg_5m "
        f"WHERE system_id={args.system}) - interval '{args.days} days'"
    )
    print(f"# OpenElectricity publication lag — system {args.system}, last {args.days} days")
    print(f"# source: {host}  (lag = created_at - interval_end, minutes)\n")

    # --- per-day summary: emissions (point 1) then price (point 2) ---
    summary = psql_csv(url, f"""
      WITH r AS (
        SELECT (interval_end + interval '10 hours')::date AS aest_day, point_id,
               EXTRACT(EPOCH FROM (created_at - interval_end))/60.0 AS lag_min
        FROM point_readings_agg_5m
        WHERE {where} AND point_id IN (1,2))
      SELECT aest_day,
        count(*) FILTER (WHERE point_id=1) AS em_n,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_min) FILTER (WHERE point_id=1))::numeric,1) AS em_med,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY lag_min) FILTER (WHERE point_id=1))::numeric,1) AS em_p90,
        round(max(lag_min) FILTER (WHERE point_id=1)::numeric,1) AS em_max,
        round(100.0*avg((lag_min>5)::int) FILTER (WHERE point_id=1),0) AS em_pct_gt5,
        count(*) FILTER (WHERE point_id=2) AS pr_n,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_min) FILTER (WHERE point_id=2))::numeric,1) AS pr_med,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY lag_min) FILTER (WHERE point_id=2))::numeric,1) AS pr_p90,
        round(max(lag_min) FILTER (WHERE point_id=2)::numeric,1) AS pr_max,
        round(100.0*avg((lag_min>5)::int) FILTER (WHERE point_id=2),0) AS pr_pct_gt5
      FROM r GROUP BY aest_day ORDER BY aest_day DESC;""")

    hdr = ["aest_day", "EM n", "EM med", "EM p90", "EM max", "EM %>5",
           "PR n", "PR med", "PR p90", "PR max", "PR %>5"]
    keys = ["aest_day", "em_n", "em_med", "em_p90", "em_max", "em_pct_gt5",
            "pr_n", "pr_med", "pr_p90", "pr_max", "pr_pct_gt5"]
    print("  ".join(f"{h:>10}" for h in hdr))
    for row in summary:
        print("  ".join(f"{(row.get(k) or ''):>10}" for k in keys))
    print("\n  EM = emissions intensity (data endpoint); PR = spot price (market endpoint)")

    # --- half-hour chart (emissions/data series, one line per day) ---
    pts = psql_csv(url, f"""
      WITH x AS (
        SELECT (interval_end + interval '10 hours') AS t,
               EXTRACT(EPOCH FROM (created_at - interval_end))/60.0 AS lag_min
        FROM point_readings_agg_5m WHERE {where} AND point_id=1)
      SELECT t::date AS aest_day,
             (floor((extract(hour from t)*60 + extract(minute from t))/30))::int AS hh_idx,
             round(avg(lag_min)::numeric,2) AS avg_lag
      FROM x GROUP BY 1,2 ORDER BY 1,2;""")
    render_chart(pts, args.out, args.system, args.days)


def render_chart(pts, out, system, days):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("\n(Pillow not installed — skipping chart. `pip3 install Pillow` to enable.)")
        return

    data = collections.defaultdict(dict)
    daylist = []
    for r in pts:
        day = r["aest_day"]
        data[day][int(r["hh_idx"])] = float(r["avg_lag"])
        if day not in daylist:
            daylist.append(day)
    daylist.sort()
    if not daylist:
        print("\n(no data to chart)")
        return

    def font(sz, bold=False):
        for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else
                  "/System/Library/Fonts/Supplemental/Arial.ttf",
                  "/System/Library/Fonts/Helvetica.ttc"):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
        return ImageFont.load_default()

    W, H = 1000, 560
    ml, mr, mt, mb = 64, 24, 78, 52
    pw, ph = W - ml - mr, H - mt - mb
    ymax, N = 60, 48
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    f_title, f_leg, f_ax = font(16, True), font(13), font(12)
    X = lambda hh: ml + pw * hh / (N - 1)
    Y = lambda v: mt + ph * (1 - min(v, ymax) / ymax)

    d.text((ml, 14), f"OpenElectricity publication lag by time of day — system {system} "
                     f"(data endpoint, emissions/power)", fill="black", font=f_title)
    for v in range(0, ymax + 1, 10):
        y = Y(v); d.line([(ml, y), (ml + pw, y)], fill="#eeeeee")
        d.text((ml - 10, y - 7), str(v), fill="#555555", font=f_ax, anchor="ra")
    y5 = Y(5)
    for x in range(ml, ml + pw, 8):
        d.line([(x, y5), (x + 4, y5)], fill="#bbbbbb")
    d.text((ml + pw - 2, y5 - 16), "5 min (≈ one interval)", fill="#999999", font=f_ax, anchor="ra")
    d.text((18, mt + ph / 2), "avg lag (min)", fill="#333333", font=f_ax, anchor="mm")
    for hh in range(0, N, 4):
        x = X(hh)
        d.line([(x, mt), (x, mt + ph)], fill="#f4f4f4")
        d.line([(x, mt + ph), (x, mt + ph + 5)], fill="#999999")
        d.text((x, mt + ph + 8), f"{hh // 2:02d}:00", fill="#555555", font=f_ax, anchor="ma")
    d.text((ml + pw / 2, H - 16), "time of day (AEST)", fill="#333333", font=f_ax, anchor="ma")
    d.line([(ml, mt), (ml, mt + ph)], fill="#333333")
    d.line([(ml, mt + ph), (ml + pw, mt + ph)], fill="#333333")

    colors = ["#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
              "#42d4f4", "#f032e6", "#469990", "#9A6324", "#000075"]
    for i, day in enumerate(daylist):
        c = colors[i % len(colors)]
        run = []
        for hh in range(N):
            if hh in data[day]:
                run.append((X(hh), Y(data[day][hh])))
            else:
                if len(run) > 1:
                    d.line(run, fill=c, width=2, joint="curve")
                run = []
        if len(run) > 1:
            d.line(run, fill=c, width=2, joint="curve")
        lx = ml + (i % 5) * 186
        ly = 50 + (i // 5) * 18
        d.line([(lx, ly + 6), (lx + 22, ly + 6)], fill=c, width=3)
        d.text((lx + 28, ly), day, fill="#333333", font=f_leg)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out)
    print(f"\nchart -> {out}  ({len(daylist)} day{'s' if len(daylist) != 1 else ''})")


if __name__ == "__main__":
    main()
