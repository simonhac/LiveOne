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
 * 🛑 It emits `interval_start`, and the column name is load-bearing. Both archives stamp the START
 * of their interval — verified against stored rows, not assumed: matching Mondo's `timestamp_utc`
 * against the LiveOne row whose interval_end is `T + 5min` gives r = 0.99870 and a median absolute
 * difference of 0.1 W, against 0.954 and 16.0 W at the same instant. `liveone import` keys rows on
 * the interval END and converts.
 *
 * 🛑 Do NOT calibrate this against `liveone device history`'s own labels without checking which end
 * they are. They are interval ENDS, while these archives stamp STARTS — so a naive comparison is
 * off by one bucket, and on 5-minute power (heavily autocorrelated) it still returns r = 0.95+,
 * which reads like agreement. That is how the SoC leg of `splink.ts` came to be a whole interval
 * late; only a shift test made the difference visible.
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
  ACCUMULATED,
  AVERAGED,
  FIFTEEN_MIN_MS,
  FIVE_MIN_MS,
  accumulatorIncrements,
  quantities,
  resampleAverages,
  resampleInstant,
  splitIncrement,
  type Series,
  type SplinkRecord,
} from "./splink";

class Refusal extends Error {}
// A function DECLARATION, deliberately: TypeScript only narrows control flow past a
// never-returning call when the callee is a declaration or an explicitly-typed const.
// As `const refuse = (msg): never => …` the annotation sits on the arrow, not the name,
// so every `if (x === undefined) refuse(…)` below left `x` possibly-undefined.
function refuse(msg: string): never {
  throw new Refusal(msg);
}

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

// ---------------------------------------------------------------------------------------------
// splink-15min --counters — LiveOne's lifetime energy counters. See `splink.ts`.
// ---------------------------------------------------------------------------------------------
/** One counter's two stored readings: the last before the run and the first after it. */
interface Anchor {
  preMs: number;
  pre: number;
  postMs: number;
  post: number;
}

/**
 * Read the anchors from a `liveone device history … --series '**' + '/energy.last' --format csv` file.
 *
 * 🛑 Those stamps are interval ENDS, and this is the one place in this tool that reads them as such.
 * The run's first interval STARTS at `fromMs`, so the reading that precedes it is the one stamped
 * `fromMs` exactly; the first reading after the run is the first non-blank stamped later than
 * `toMs + 5min`.
 */
function readAnchors(
  file: string,
  fromMs: number,
  toMs: number,
): Map<string, Anchor> {
  const csv = readCsv(file);
  const tsIdx = csv.header.indexOf("timestamp_utc");
  if (tsIdx === -1)
    refuse(
      `${file} has no "timestamp_utc" column — is that a --format csv history?`,
    );
  const out = new Map<string, Anchor>();
  const runEndMs = toMs + FIVE_MIN_MS;

  for (const [col, head] of csv.header.entries()) {
    // "1/load/energy.last (Wh)" -> logical path "load/energy", and the unit is not optional: these
    // counters are Wh in LiveOne and kWh in the archive, and the factor between them is 1000.
    const m = /^\d+\/(.+)\.last \((\w+)\)$/.exec(head);
    if (!m) continue;
    const [, seriesPath, unit] = m;
    if (unit !== "Wh")
      refuse(`${file}: "${head}" is in ${unit}; these counters must be Wh`);
    let pre: { ms: number; v: number } | null = null;
    let post: { ms: number; v: number } | null = null;
    for (const row of csv.rows) {
      const ms = Date.parse(row[tsIdx]);
      const raw = row[col];
      if (!Number.isFinite(ms) || raw === undefined || raw === "") continue;
      const v = num(raw, `${file}: "${head}" at ${row[tsIdx]}`)!;
      if (ms === fromMs) pre = { ms, v };
      if (ms > runEndMs && post === null) post = { ms, v };
    }
    if (pre === null || post === null) continue;
    out.set(seriesPath, {
      preMs: pre.ms,
      pre: pre.v,
      postMs: post.ms,
      post: post.v,
    });
  }
  if (out.size === 0)
    refuse(
      `${file} carries no "<device>/<path>.last (Wh)" column with a reading both at ` +
        `${new Date(fromMs).toISOString()} and after ${new Date(runEndMs).toISOString()} — ` +
        `widen the history window the anchors came from`,
    );
  return out;
}

function produceSplinkCounters(
  csvs: Csv[],
  fromMs: number,
  toMs: number,
  anchorsFile: string,
): Produced[] {
  const anchors = readAnchors(anchorsFile, fromMs, toMs);

  // One record of padding on the low side: the first window's increment is unknowable without its
  // predecessor. None needed on the high side — an increment looks backwards only.
  const padFrom = fromMs - FIFTEEN_MIN_MS;
  const padTo = toMs + FIFTEEN_MIN_MS;

  // The power reconstruction, reused verbatim as the within-window SHAPE so the counters agree with
  // the power series imported beside them.
  const shapeRows = new Map<string, Map<number, number>>();
  for (const p of produceSplink(csvs, padFrom, padTo))
    shapeRows.set(p.source, new Map(p.rows.map((r) => [r.startMs, r.value])));

  // The accumulators themselves, summed over their columns and converted kWh -> Wh.
  const stamps: number[] = [];
  const byStamp = new Map<number, Map<string, number | null>>();
  for (const csv of csvs) {
    const tsIdx = columnIndex(csv, "timestamp_utc");
    const idx = ACCUMULATED.map((a) =>
      a.columns.map((c) => ({ i: columnIndex(csv, c.name), scale: c.scale })),
    );
    for (const row of csv.rows) {
      const ms = Date.parse(row[tsIdx]);
      if (!Number.isFinite(ms) || ms < padFrom || ms > padTo) continue;
      const cells = new Map<string, number | null>();
      for (const [k, a] of ACCUMULATED.entries()) {
        let total: number | null = 0;
        for (const { i, scale } of idx[k]) {
          const v = num(
            row[i],
            `${csv.file}: "${a.columns[0].name}" at ${row[tsIdx]}`,
          );
          // Any missing half makes the whole quantity unknown — never a zero standing in.
          if (v === null) {
            total = null;
            break;
          }
          total += v * scale * 1000; // kWh -> Wh
        }
        cells.set(a.series, total);
      }
      if (!byStamp.has(ms)) stamps.push(ms);
      byStamp.set(ms, cells);
    }
  }
  stamps.sort((a, b) => a - b);

  const out: Produced[] = [];
  for (const a of ACCUMULATED) {
    const anchor = anchors.get(a.series);
    if (anchor === undefined)
      refuse(
        `no anchor for "${a.series}" — the history file must carry its .last both at ` +
          `${new Date(fromMs).toISOString()} and after the run`,
      );
    const incs = accumulatorIncrements(
      stamps.map((tMs) => ({
        tMs,
        value: byStamp.get(tMs)!.get(a.series) ?? null,
      })),
    );
    const shape = a.shape ? shapeRows.get(a.shape) : undefined;

    // Chain from the stored reading before the run.
    let cum = anchor.pre;
    const rows: Array<{ startMs: number; value: number }> = [];
    let unshaped = 0;
    for (const { tMs, increment } of incs) {
      if (increment === null) continue;
      const starts: [number, number, number] = [
        tMs - FIFTEEN_MIN_MS,
        tMs - FIFTEEN_MIN_MS + FIVE_MIN_MS,
        tMs - FIFTEEN_MIN_MS + 2 * FIVE_MIN_MS,
      ];
      if (starts[0] < fromMs || starts[2] > toMs) continue; // a window the run does not fully cover
      const s = shape
        ? (starts.map((ms) => shape.get(ms) ?? NaN) as [number, number, number])
        : null;
      const usable = s !== null && s.every((v) => Number.isFinite(v));
      if (!usable && a.shape) unshaped++;
      const split = splitIncrement(increment, usable ? s : null);
      for (let i = 0; i < 3; i++) {
        cum += split[i];
        rows.push({ startMs: starts[i], value: cum });
      }
    }
    if (rows.length === 0)
      refuse(
        `"${a.series}" produced no windows inside ${describeWindow(fromMs, toMs)}`,
      );

    // 🛑 The check that makes this trustworthy. The chain's end and the next stored reading differ
    // by exactly the ONE interval between them, so the leftover must be a plausible interval — not
    // negative (a counter cannot run backwards) and not a multiple of the biggest bucket in the run.
    const leftover = anchor.post - cum;
    const biggest = rows.reduce(
      (mx, r, i) =>
        Math.max(
          mx,
          i === 0 ? r.value - anchor.pre : r.value - rows[i - 1].value,
        ),
      0,
    );
    const bound = Math.max(biggest * 2, 1);
    if (leftover < 0 || leftover > bound)
      refuse(
        `"${a.series}": chaining the archive's own increments onto ${anchor.pre} Wh lands at ` +
          `${Math.round(cum)} Wh, but the next stored reading (${new Date(anchor.postMs).toISOString()}) ` +
          `is ${anchor.post} Wh — a leftover of ${Math.round(leftover)} Wh for the one interval ` +
          `between them, against a largest bucket of ${Math.round(biggest)} Wh. The two instruments ` +
          `disagree by more than one interval; nothing here scales to hide that.`,
      );
    out.push({
      source: a.series,
      match: { by: "logicalPath", value: a.series },
      rows,
      note:
        `chained from ${anchor.pre} Wh; leftover ${Math.round(leftover)} Wh ` +
        `(${((leftover * 12) / 1000).toFixed(2)} kW) for the interval ending ` +
        `${new Date(anchor.postMs).toISOString()}` +
        (unshaped > 0 ? `; ${unshaped} window(s) split in equal thirds` : ""),
    });
  }
  return out;
}

const describeWindow = (a: number, b: number) =>
  `${new Date(a).toISOString()}..${new Date(b).toISOString()}`;

const SPLINK_COUNTER_ALGORITHM = {
  name: "splink-15min-accumulators-to-5m-counters",
  doc: "scripts/archive/splink.ts",
  notes: [
    "SP LINK's *_accumulated_kwh are DAY totals that reset at local midnight; a window's energy is value - previous, except across the reset where the value IS the increment. The reset is detected by the value falling, never by a clock.",
    "LiveOne's energy points are LIFETIME counters, so the run is chained onto the last stored .last before it; `liveone import` differences each row against its predecessor.",
    "Each 15-minute increment is split across its three 5-minute buckets in proportion to the reconstructed POWER shape for the same quantity, so the counters agree with the power series; where the shape is absent or non-positive the split is equal thirds. Either way the window's energy is preserved exactly.",
    "Nothing is scaled to fit. The chain's end is checked against the first stored reading after the run, and the leftover must be one plausible interval; a larger disagreement is a refusal.",
    "Quality is `estimated`: the 15-minute windows are the inverter's own metered energy, but their distribution inside each window is modelled.",
  ],
};

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
  // 🛑 Naming a subset is not a convenience, it is what keeps the manifest honest. One repair often
  // wants only the columns a device could never see (Mondo's SoC and site load) while its other
  // series already hold real measurements an import must not touch. Generating all of them and
  // trimming the CSV afterwards would leave the manifest describing rows nobody imported.
  // 🛑 The counters are a SEPARATE run, not extra columns on the power one. They target different
  // points, carry a different algorithm note, and — unlike everything else here — depend on what
  // LiveOne already holds. Folding them in would make one manifest describe two provenances.
  const anchorsFile = flag("counters");

  const only = flag("columns")
    ?.split(",")
    .map((c: string) => c.trim())
    .filter((c: string) => c.length > 0);

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
  const startDay = start.slice(0, 10);
  const endDay = end.slice(0, 10);
  for (const g of archive.gaps)
    if (!(endDay < g.from || startDay > g.to))
      refuse(
        `${start}..${end} overlaps a gap the archive declares (${g.from}..${g.to}) — ` +
          `the vendor has nothing there, so there is nothing to import`,
      );

  // --- the rows ---------------------------------------------------------------------------------
  // One file per local calendar year, and a UTC window can straddle two of them.
  const years = [...new Set([startDay.slice(0, 4), endDay.slice(0, 4)])];
  const files = years
    .map((y) => path.join(sourceDir, `${y}.csv`))
    .filter((f) => fs.existsSync(f));
  if (files.length === 0) refuse(`no ${years.join("/")}.csv in ${sourceDir}`);
  const csvs = files.map(readCsv);

  // A bare date means the whole UTC day, inclusive of both ends; a full ISO instant means exactly
  // that instant. An outage does not begin at midnight, and the alternative — generate the whole day
  // and trim afterwards — would leave the manifest describing rows that were never imported.
  const bound = (v: string, endOfDay: boolean): number => {
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(v)
      ? Date.parse(`${v}T${endOfDay ? "23:59:59" : "00:00:00"}Z`)
      : Date.parse(v);
    if (!Number.isFinite(ms))
      refuse(`--start/--end must be YYYY-MM-DD or an ISO instant; got "${v}"`);
    return ms;
  };
  const fromMs = bound(start, false);
  const toMs = bound(end, true);
  if (fromMs > toMs) refuse(`--start is after --end`);

  if (anchorsFile !== undefined && kind !== "splink-15min")
    refuse(
      `--counters is a splink-15min reconstruction; this archive is ${kind}`,
    );

  let produced = (
    anchorsFile !== undefined
      ? produceSplinkCounters(csvs, fromMs, toMs, anchorsFile)
      : kind === "mondo-5min"
        ? produceMondo(csvs, fromMs, toMs)
        : produceSplink(csvs, fromMs, toMs)
  ).filter((p) => p.rows.length > 0);

  if (only) {
    const available = new Set(produced.map((p) => p.source));
    // A name that matches nothing is a refusal: silently producing fewer columns than asked for is
    // how a repair comes to be half-done without anyone noticing.
    const unknown = only.filter((c: string) => !available.has(c));
    if (unknown.length > 0)
      refuse(
        `--columns names series this archive did not produce here: ${unknown.join(", ")}. ` +
          `Available: ${[...available].join(", ")}`,
      );
    produced = produced.filter((p) => only.includes(p.source));
  }

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
      files: [
        ...files.map(fileDigest),
        // The anchors are an INPUT that came out of LiveOne, not out of the archive — cited so the
        // readings the chain rests on can be checked against what was stored at the time.
        ...(anchorsFile !== undefined ? [fileDigest(anchorsFile)] : []),
      ],
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
    ...(kind === "splink-15min"
      ? {
          algorithm:
            anchorsFile !== undefined
              ? SPLINK_COUNTER_ALGORITHM
              : SPLINK_ALGORITHM,
        }
      : {}),
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
    only ??
    (kind === "mondo-5min"
      ? MONDO_5MIN.map((m) => m.source)
      : anchorsFile !== undefined
        ? ACCUMULATED.map((a) => a.series)
        : [...AVERAGED, "bidi.battery/soc"]);
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
