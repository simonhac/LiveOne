#!/usr/bin/env tsx
/**
 * archive-to-import — turn a filed vendor archive into the two files `liveone import` needs.
 *
 * Reads a `monitoring-archive/<source>/<date>/` directory (the shape
 * `config/energy-monitoring-filing.md` specifies) and writes:
 *
 *   <out>.csv            point,interval_start,value — exactly what `liveone import --file` takes
 *   <out>.manifest.json  what `liveone session create --manifest` files as the provenance record
 *
 * 🛑 BOTH come out of ONE pass, and that is the point. A manifest written by hand describes what
 * someone believed the mapping was; this one describes the mapping that actually produced the rows
 * beside it, column by column, with the archive's own checksums cited rather than restated.
 *
 * 🛑 This touches no database and calls no vendor. It resolves `pt_` ids from a points file you
 * captured with `liveone device points <d> --format json`, so the resolution is reviewable before
 * anything is written and cannot silently pick a different point on a different environment.
 *
 * 🛑 It emits `interval_start`, and the column name is load-bearing. Every archive here stamps the
 * START of its interval — verified, not assumed: Mondo's `timestamp_utc` correlates with LiveOne's
 * start-labelled 5-minute buckets at r = 0.9976–0.9999 and materially worse at any shift. `liveone
 * import` keys rows on the interval END and converts; naming the column `interval_end` instead
 * would validate cleanly and put every row one interval late.
 *
 * 🛑 Blank is ABSENT, never zero. A blank circuit in one of these archives was not reporting; it
 * was not drawing 0 W. A blank cell emits no row, so the hole stays a hole.
 *
 * Two archive kinds, and they are not the same job:
 *
 *   mondo-5min    a COLUMN MAPPING. The archive's values are already LiveOne's values, at
 *                 LiveOne's resolution, in LiveOne's units — import them as `good`, the vendor's
 *                 own record of those intervals.
 *   splink-15min  a RECONSTRUCTION. See `splink.ts`: LiveOne's series are identities over the
 *                 inverter's log, resampled from 15 minutes to 5 — import them as `estimated`.
 *
 *   npx tsx scripts/archive/to-import-csv.ts \
 *     --source ~/Documents/hac-admin/.../mondo-5min/2026-09-11 \
 *     --points points-6.json --device 6 \
 *     --start 2026-09-10 --end 2026-09-11 --out /tmp/job2
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseArchiveManifest,
  fileDigest,
  gitSha,
  type SessionManifest,
} from "./manifest";
import {
  MONDO_5MIN,
  describeMatcher,
  resolveMatcher,
  type Matcher,
  type PointRow,
} from "./mapping";
import {
  AVERAGED,
  FIFTEEN_MIN_MS,
  quantities,
  resampleAverages,
  resampleInstant,
  type Series,
  type SplinkRecord,
} from "./splink";

class Refusal extends Error {}
const refuse = (msg: string): never => {
  throw new Refusal(msg);
};

function flag(name: string, required: true): string;
function flag(name: string, required?: false): string | undefined;
function flag(name: string, required = false): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit?.slice(name.length + 3);
  if (required && !value) refuse(`--${name} is required`);
  return value;
}

/** Split one CSV line, unquoting the `"…"` cells the SP LINK export uses throughout. */
function splitCsv(line: string): string[] {
  return line
    .split(",")
    .map((c) => c.trim())
    .map((c) => (c.startsWith('"') && c.endsWith('"') ? c.slice(1, -1) : c));
}

interface Csv {
  header: string[];
  rows: string[][];
  file: string;
}

function readCsv(file: string): Csv {
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) refuse(`${file} has no rows`);
  return {
    header: splitCsv(lines[0]),
    rows: lines.slice(1).map(splitCsv),
    file,
  };
}

function columnIndex(csv: Csv, name: string): number {
  const i = csv.header.indexOf(name);
  // A column the archive does not carry is a refusal, not a silent skip: the mapping describes what
  // this archive kind IS, so a missing one means the file is not what it claims.
  if (i === -1) refuse(`${csv.file} has no "${name}" column`);
  return i;
}

const num = (raw: string | undefined, where: string): number | null => {
  if (raw === undefined || raw === "") return null; // blank is ABSENT
  const n = Number(raw);
  if (!Number.isFinite(n)) refuse(`${where} is not a number: ${raw}`);
  return n;
};

/** One output series: what to call it, which point it is for, and its rows. */
interface Produced {
  source: string;
  match: Matcher;
  rows: Array<{ startMs: number; value: number }>;
  /** Set when the value is not the archive's own number. */
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// mondo-5min — a straight column mapping.
// ---------------------------------------------------------------------------------------------
function produceMondo(csvs: Csv[], fromMs: number, toMs: number): Produced[] {
  const out: Produced[] = MONDO_5MIN.map((m) => ({
    source: m.source,
    match: m.match,
    rows: [],
  }));
  for (const csv of csvs) {
    const tsIdx = columnIndex(csv, "timestamp_utc");
    const idx = MONDO_5MIN.map((m) => columnIndex(csv, m.source));
    for (const row of csv.rows) {
      const ms = Date.parse(row[tsIdx]);
      if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
      for (const [i, m] of MONDO_5MIN.entries()) {
        const v = num(
          row[idx[i]],
          `${csv.file}: "${m.source}" at ${row[tsIdx]}`,
        );
        if (v === null) continue;
        out[i].rows.push({
          startMs: ms,
          value: m.scale === undefined ? v : v * m.scale,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// splink-15min — the reconstruction in `splink.ts`.
// ---------------------------------------------------------------------------------------------
function produceSplink(csvs: Csv[], fromMs: number, toMs: number): Produced[] {
  // 🛑 Read one record PAST the window on each side. A bucket at the edge is interpolated against
  // its neighbour, and cutting the input to the window first would make every run's edges hold
  // flat — a real reconstruction quietly degraded by where someone chose to cut.
  const padFrom = fromMs - FIFTEEN_MIN_MS;
  const padTo = toMs + FIFTEEN_MIN_MS;

  const records: SplinkRecord[] = [];
  for (const csv of csvs) {
    const i = (n: string) => columnIndex(csv, n);
    const c = {
      ts: i("timestamp_utc"),
      load: i("load_ac_power_average_kw"),
      acCoupled: i("ac_coupled_power_average_kw"),
      shunt1: i("shunt1_current_average_a"),
      dcV: i("dc_voltage_average_v"),
      acIn: i("ac_input_power_average_kw"),
      soc: i("state_of_charge_percent"),
    };
    for (const row of csv.rows) {
      const ms = Date.parse(row[c.ts]);
      if (!Number.isFinite(ms) || ms < padFrom || ms > padTo) continue;
      const at = `${csv.file} at ${row[c.ts]}`;
      records.push({
        tMs: ms,
        loadAcKw: num(row[c.load], `${at} load_ac_power_average_kw`),
        acCoupledKw: num(row[c.acCoupled], `${at} ac_coupled_power_average_kw`),
        shunt1A: num(row[c.shunt1], `${at} shunt1_current_average_a`),
        dcVoltageV: num(row[c.dcV], `${at} dc_voltage_average_v`),
        acInputKw: num(row[c.acIn], `${at} ac_input_power_average_kw`),
        socPct: num(row[c.soc], `${at} state_of_charge_percent`),
      });
    }
  }
  records.sort((a, b) => a.tMs - b.tMs);

  const q = records.map((r) => ({ tMs: r.tMs, v: quantities(r) }));
  const series: Series[] = [...AVERAGED, "bidi.battery/soc"];
  return series.map((s) => {
    const byT = q.map((x) => ({ tMs: x.tMs, value: x.v[s] }));
    const resampled =
      s === "bidi.battery/soc" ? resampleInstant(byT) : resampleAverages(byT);
    const held = resampled.filter((r) => r.held).length;
    return {
      source: s,
      match: { by: "logicalPath", value: s },
      // Padding is an input, not an output: trim back to the window that was asked for.
      rows: resampled
        .filter((r) => r.startMs >= fromMs && r.startMs <= toMs)
        .map((r) => ({ startMs: r.startMs, value: r.value })),
      note:
        held > 0
          ? `${held} bucket(s) held flat — no adjacent record to interpolate against`
          : undefined,
    };
  });
}

const SPLINK_ALGORITHM = {
  name: "splink-15min-to-5m",
  doc: "scripts/archive/splink.ts",
  notes: [
    "LiveOne's series are identities over the SP PRO log, not columns of it: solar.local = -shunt1_current_average_a x dc_voltage_average_v (shunt2 is identically zero at this site), solar = remote + local, battery = load - solar. Regressed against LiveOne over 2026-08 at r = 0.984-1.000, no fitted constants.",
    "inverter_ac_power_average_kw is NOT battery power: it correlates at -0.970 with slope -1.302, because it is AC throughput and the 1.3 was solar's missing DC half.",
    "15-minute averages cover the TRAILING window (T-15, T] and are spread over the three 5-minute buckets starting at T-15, interpolated between window centres and rescaled so each triple's mean is exactly the recorded average — smooth and interval-energy preserving.",
    "SoC is instantaneous, not an average: a stamp lands on its own bucket and the two between are interpolated, bounded to one 15-minute step.",
    "Quality is `estimated`, not `calculated`: the resample is what makes these inexact.",
  ],
};

function main() {
  const sourceDir = flag("source", true);
  const pointsFile = flag("points", true);
  const device = flag("device", true);
  const start = flag("start", true);
  const end = flag("end", true);
  const out = flag("out", true);

  // --- the archive ------------------------------------------------------------------------------
  const manifestPath = path.join(sourceDir, "manifest.md");
  if (!fs.existsSync(manifestPath))
    refuse(
      `no manifest.md in ${sourceDir} — is that an archive session directory?`,
    );
  const archive = parseArchiveManifest(manifestPath);

  const kind = /mondo-5min/.test(archive.title)
    ? "mondo-5min"
    : /splink-15min/.test(archive.title)
      ? "splink-15min"
      : refuse(
          `unrecognised archive kind; the manifest says "${archive.title}". ` +
            `Known: mondo-5min, splink-15min`,
        );

  // 🛑 A window inside a declared whole-day gap is a refusal, not an empty result. The archive says
  // the vendor had nothing there; producing zero rows would look identical to "the mapping missed".
  for (const g of archive.gaps)
    if (!(end < g.from || start > g.to))
      refuse(
        `${start}..${end} overlaps a gap the archive declares (${g.from}..${g.to}) — ` +
          `the vendor has nothing there, so there is nothing to import`,
      );

  // --- the rows ---------------------------------------------------------------------------------
  // One file per local calendar year, and a UTC window can straddle two of them.
  const years = [...new Set([start.slice(0, 4), end.slice(0, 4)])];
  const files = years
    .map((y) => path.join(sourceDir, `${y}.csv`))
    .filter((f) => fs.existsSync(f));
  if (files.length === 0) refuse(`no ${years.join("/")}.csv in ${sourceDir}`);
  const csvs = files.map(readCsv);

  // The window is expressed in whole UTC days, inclusive of both ends.
  const fromMs = Date.parse(`${start}T00:00:00Z`);
  const toMs = Date.parse(`${end}T23:59:59Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs))
    refuse(`--start/--end must be YYYY-MM-DD`);

  const produced = (kind === "mondo-5min" ? produceMondo : produceSplink)(
    csvs,
    fromMs,
    toMs,
  ).filter((p) => p.rows.length > 0);

  if (produced.length === 0)
    refuse(
      `no rows in ${start}..${end} — the archive spans ${archive.coverage["Span"] ?? "?"}`,
    );

  // --- the points -------------------------------------------------------------------------------
  const pointsDoc = JSON.parse(fs.readFileSync(pointsFile, "utf8")) as {
    points?: PointRow[];
  };
  const points = pointsDoc.points ?? [];
  if (points.length === 0) refuse(`${pointsFile} lists no points`);

  const resolved = new Map<string, PointRow>();
  for (const p of produced) {
    const hits = resolveMatcher(points, p.match);
    // Exactly one. Zero means the point does not exist yet (mint it first); more than one means the
    // matcher is ambiguous and picking either would be a guess nothing downstream could detect.
    if (hits.length === 0)
      refuse(
        `no point for "${p.source}" (${describeMatcher(p.match)}) in ${pointsFile}`,
      );
    if (hits.length > 1)
      refuse(
        `"${p.source}" (${describeMatcher(p.match)}) matches ${hits.length} points: ` +
          hits.map((h) => h.id).join(", "),
      );
    resolved.set(p.source, hits[0]);
  }

  // --- write ------------------------------------------------------------------------------------
  const lines = ["point,interval_start,value"];
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const p of produced)
    for (const r of p.rows) {
      lines.push(
        `${resolved.get(p.source)!.id},${new Date(r.startMs).toISOString()},${r.value}`,
      );
      if (r.startMs < firstMs) firstMs = r.startMs;
      if (r.startMs > lastMs) lastMs = r.startMs;
    }

  const csvOut = `${out}.csv`;
  const manifestOut = `${out}.manifest.json`;
  fs.writeFileSync(csvOut, `${lines.join("\n")}\n`);

  const sessionManifest: SessionManifest = {
    kind: "archive-import",
    generatedAt: new Date().toISOString(),
    tool: {
      name: "scripts/archive/to-import-csv.ts",
      gitSha: gitSha(),
      argv: process.argv.slice(2),
    },
    archive: {
      directory: sourceDir,
      manifest: {
        path: path.basename(archive.path),
        sha256: archive.sha256,
        title: archive.title,
      },
      files: files.map(fileDigest),
      declaredCoverage: archive.coverage,
    },
    device: { handle: Number.isNaN(Number(device)) ? device : Number(device) },
    window: {
      start: new Date(firstMs).toISOString(),
      end: new Date(lastMs).toISOString(),
      stamp: "interval_start",
    },
    mapping: produced.map((p) => {
      const pt = resolved.get(p.source)!;
      return {
        source: p.source,
        point: pt.id,
        logicalPath: pt.logicalPath,
        physicalPath: pt.physicalPath,
        unit: pt.unit,
        // Only what the points file actually carries. `transform` is not in that payload, and a
        // hardcoded null beside real fields would read as a fact nobody established.
        metricType: pt.metricType,
        rows: p.rows.length,
      };
    }),
    ...(kind === "splink-15min" ? { algorithm: SPLINK_ALGORITHM } : {}),
    rows: lines.length - 1,
  };
  fs.writeFileSync(
    manifestOut,
    `${JSON.stringify(sessionManifest, null, 2)}\n`,
  );

  console.log(`wrote ${csvOut}  (${sessionManifest.rows} rows, ${kind})`);
  console.log(`wrote ${manifestOut}`);
  console.log(
    `window ${new Date(firstMs).toISOString()} .. ${new Date(lastMs).toISOString()}  (interval_start)`,
  );
  for (const p of produced) {
    const pt = resolved.get(p.source)!;
    console.log(
      `  ${p.source.padEnd(26)} -> ${pt.id}  ${pt.logicalPath ?? "(no logical path)"}  ${p.rows.length} row(s)` +
        (p.note ? `  [${p.note}]` : ""),
    );
  }
  // Named, not silent: a series that produced nothing is either absent from the archive or a
  // mapping that missed, and the difference matters.
  const names = new Set(produced.map((p) => p.source));
  const expected =
    kind === "mondo-5min"
      ? MONDO_5MIN.map((m) => m.source)
      : [...AVERAGED, "bidi.battery/soc"];
  for (const s of expected)
    if (!names.has(s))
      console.log(
        `  ${s.padEnd(26)} -> no rows (absent throughout this window)`,
      );
}

try {
  main();
} catch (e) {
  if (e instanceof Refusal) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
