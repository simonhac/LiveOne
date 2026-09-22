#!/usr/bin/env tsx
/**
 * Rebuild Kinkora's Fronius (fusher) 5-minute ENERGY rows from Mondo's integrated POWER — the data
 * repair for docs/incidents/2026-08-11-fronius-tick-skip-halved-energy.md, kept (not temp) because
 * the same arithmetic is the answer to any future window where the hub under-delivered.
 *
 * Offline and read-only: it reads CSVs the `liveone` CLI already wrote and writes a CSV for
 * `liveone import`. It touches no database and no API.
 *
 * Inputs (all from the CLI, same window):
 *   --mondo   `liveone device history <mondo> --interval 5m --format csv` with the series
 *             bidi.grid/power.avg, bidi.battery/power.avg, source.solar.remote/power.avg,
 *             source.solar.local/power.avg and (if it existed then) load/power.avg
 *   --fusher  `liveone device history <fusher> --interval 5m --format csv` with the six energy
 *             series (source.solar, load, bidi.battery.charge, bidi.battery.discharge,
 *             bidi.grid.import, bidi.grid.export — each `/energy.delta`)
 *   --points  `liveone device points <fusher> --format json` — the pt_… ids the import needs
 *
 * Arithmetic, per 5-minute bucket (history stamps the interval END, as does the output):
 *   Wh = mean W × 5/60
 *   solar                 = remote + local circuits
 *   grid import / export  = the positive / negative part of grid power × gridSign
 *   battery out / in      = the positive / negative part of battery power × batterySign
 *   load                  = Mondo site load if present, else the balance solar + grid + battery
 * It is a DIFFERENT instrument, which is why the import is graded `estimated`. Measured against
 * Fronius on healthy days: solar, load and battery agree within ~1–3%, grid import within ~5%.
 * 🛑 Grid EXPORT does not: a 5-minute mean nets out import/export flicker inside the bucket, and
 * the stored ÷ derived ratio wanders from ~0.4 to ~1.4 between healthy days. Decide separately
 * whether to write that point at all.
 *
 * Signs are NOT assumed. `--calibrate` fits them on a HEALTHY window: for each energy point it
 * reports Σ fusher / Σ derived under both signs, and the right sign is the one near 1.00. The
 * defaults (+1, +1: grid + = import, battery + = discharge) are what that fit gave on 10 Sep 2026.
 *
 * Usage:
 *   tsx scripts/utils/derive-fusher-wh-from-mondo.ts --calibrate --mondo=m.csv --fusher=f.csv
 *   tsx scripts/utils/derive-fusher-wh-from-mondo.ts --mondo=m.csv --fusher=f.csv \
 *     --points=points.json --from=2026-08-11T00:05:00+10:00 --to=2026-08-31T00:00:00+10:00 \
 *     --out=.context/fusher-repair/import.csv
 *
 * `--from`/`--to` bound the INTERVAL ENDS written (inclusive). The per-day table printed to stderr
 * (stored ÷ derived, per point) is how to place the edges: a halved day reads ~0.50, a healthy one
 * ~1.00, and the transition days show where inside them the change happened.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BUCKET_H = 5 / 60;

/** The six fusher energy points, by logical path, and how each is derived from Mondo power. */
const TARGETS = [
  "source.solar/energy",
  "load/energy",
  "bidi.battery.charge/energy",
  "bidi.battery.discharge/energy",
  "bidi.grid.import/energy",
  "bidi.grid.export/energy",
] as const;
type Target = (typeof TARGETS)[number];

interface Args {
  mondo: string;
  fusher?: string;
  points?: string;
  from?: number;
  to?: number;
  out?: string;
  calibrate: boolean;
  gridSign: 1 | -1;
  batterySign: 1 | -1;
}

function parseArgs(argv: string[]): Args {
  const get = (n: string) =>
    argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const sign = (n: string): 1 | -1 => {
    const v = get(n) ?? "1";
    if (v !== "1" && v !== "-1") throw new Error(`--${n} must be 1 or -1`);
    return v === "1" ? 1 : -1;
  };
  const time = (n: string) => {
    const v = get(n);
    if (v === undefined) return undefined;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) throw new Error(`--${n}=${v} is not a timestamp`);
    return ms;
  };
  const mondo = get("mondo");
  if (!mondo) throw new Error("--mondo=<csv> is required");
  return {
    mondo,
    fusher: get("fusher"),
    points: get("points"),
    from: time("from"),
    to: time("to"),
    out: get("out"),
    calibrate: argv.includes("--calibrate"),
    gridSign: sign("grid-sign"),
    batterySign: sign("battery-sign"),
  };
}

/**
 * A `device history --format csv` file → interval-end ms → { "<logical>/<metric>.<field>": value }.
 * Headers look like `6/bidi.grid/power.avg (W)`; the device handle and unit are stripped so both
 * devices' columns key the same way.
 */
function readHistoryCsv(path: string): Map<number, Record<string, number>> {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const cols = header.split(",");
  const utc = cols.indexOf("timestamp_utc");
  if (utc < 0) throw new Error(`${path}: no timestamp_utc column`);
  const keys = cols.map((c) =>
    c
      .replace(/^"|"$/g, "")
      .replace(/^\d+\//, "")
      .replace(/ \(.*\)$/, ""),
  );
  const out = new Map<number, Record<string, number>>();
  for (const line of lines) {
    const cells = line.split(",");
    const row: Record<string, number> = {};
    cells.forEach((cell, i) => {
      if (i === utc || cell === "" || !keys[i].includes("/")) return;
      const v = Number(cell);
      if (Number.isFinite(v)) row[keys[i]] = v;
    });
    out.set(Date.parse(cells[utc]), row);
  }
  return out;
}

/** Derived Wh for every target, from one bucket of Mondo power. null when a needed input is absent. */
function deriveBucket(
  m: Record<string, number>,
  gridSign: 1 | -1,
  batterySign: 1 | -1,
): Record<Target, number> | null {
  const grid = m["bidi.grid/power.avg"];
  const battery = m["bidi.battery/power.avg"];
  const remote = m["source.solar.remote/power.avg"];
  const local = m["source.solar.local/power.avg"];
  if ([grid, battery, remote, local].some((v) => v === undefined)) return null;
  const g = grid * gridSign;
  const b = battery * batterySign;
  const solar = Math.max(0, remote) + Math.max(0, local);
  const load = m["load/power.avg"] ?? solar + g + b;
  const wh = (w: number) => Math.round(w * BUCKET_H * 1000) / 1000;
  return {
    "source.solar/energy": wh(solar),
    "load/energy": wh(Math.max(0, load)),
    "bidi.battery.charge/energy": wh(Math.max(0, -b)),
    "bidi.battery.discharge/energy": wh(Math.max(0, b)),
    "bidi.grid.import/energy": wh(Math.max(0, g)),
    "bidi.grid.export/energy": wh(Math.max(0, -g)),
  };
}

const aestDay = (ms: number) =>
  // A bucket belongs to the day its interval STARTS in (interval-end convention).
  new Date(ms - 1000 + 10 * 3_600_000).toISOString().slice(0, 10);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mondo = readHistoryCsv(args.mondo);
  const fusher = args.fusher ? readHistoryCsv(args.fusher) : null;

  if (args.calibrate) {
    if (!fusher) throw new Error("--calibrate needs --fusher");
    console.log(
      "Σ fusher ÷ Σ derived, over buckets both hold (≈1.00 is the right sign)\n",
    );
    console.log(
      "  point                            grid+ batt+   grid- batt+   grid+ batt-   grid- batt-",
    );
    for (const t of TARGETS) {
      const cells = (
        [
          [1, 1],
          [-1, 1],
          [1, -1],
          [-1, -1],
        ] as const
      ).map(([gs, bs]) => {
        let stored = 0;
        let derived = 0;
        for (const [ms, m] of mondo) {
          const f = fusher.get(ms)?.[`${t}.delta`];
          const d = deriveBucket(m, gs, bs);
          if (f === undefined || !d) continue;
          stored += f;
          derived += d[t];
        }
        return derived > 0 ? (stored / derived).toFixed(3) : "—";
      });
      console.log(
        `  ${t.padEnd(30)} ${cells.map((c) => c.padStart(12)).join("  ")}`,
      );
    }
    return;
  }

  if (
    !args.points ||
    args.from === undefined ||
    args.to === undefined ||
    !args.out
  )
    throw new Error(
      "--points, --from, --to and --out are required (or pass --calibrate)",
    );

  const pointsDoc = JSON.parse(readFileSync(args.points, "utf8"));
  const points: { id: string; logicalPath?: string | null }[] =
    pointsDoc.points ?? pointsDoc;
  const idFor = new Map<string, string>();
  // `logicalPath` is already `<stem>/<metric>` (e.g. `source.solar/energy`).
  for (const p of points) if (p.logicalPath) idFor.set(p.logicalPath, p.id);
  for (const t of TARGETS)
    if (!idFor.has(t)) throw new Error(`no point for ${t} in ${args.points}`);

  const rows: string[] = ["point,interval_end,value"];
  const perDay = new Map<
    string,
    Record<string, { stored: number; derived: number }>
  >();
  let skipped = 0;
  for (const [ms, m] of [...mondo].sort((a, b) => a[0] - b[0])) {
    if (ms < args.from || ms > args.to) continue;
    const d = deriveBucket(m, args.gridSign, args.batterySign);
    if (!d) {
      skipped++;
      continue;
    }
    const day = aestDay(ms);
    const acc = perDay.get(day) ?? {};
    perDay.set(day, acc);
    for (const t of TARGETS) {
      rows.push(`${idFor.get(t)},${new Date(ms).toISOString()},${d[t]}`);
      const stored = fusher?.get(ms)?.[`${t}.delta`];
      if (stored !== undefined) {
        const a = (acc[t] ??= { stored: 0, derived: 0 });
        a.stored += stored;
        a.derived += d[t];
      }
    }
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, rows.join("\n") + "\n");
  console.error(
    `wrote ${rows.length - 1} rows (${(rows.length - 1) / TARGETS.length} buckets × ${TARGETS.length} points) to ${args.out}` +
      (skipped
        ? `; ${skipped} bucket(s) skipped — a Mondo input was missing`
        : ""),
  );
  if (fusher) {
    console.error(
      "\nstored ÷ derived per day (≈0.50 = halved, ≈1.00 = healthy)",
    );
    console.error(
      `  day         ${TARGETS.map((t) => t.split("/")[0].slice(-12).padStart(12)).join(" ")}`,
    );
    for (const [day, acc] of perDay)
      console.error(
        `  ${day}  ${TARGETS.map((t) => {
          const a = acc[t];
          return (
            a && a.derived > 0 ? (a.stored / a.derived).toFixed(2) : "—"
          ).padStart(12);
        }).join(" ")}`,
      );
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
