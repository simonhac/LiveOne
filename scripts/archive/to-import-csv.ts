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
  type ColumnMapping,
  type PointRow,
} from "./mapping";

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

  // Only the one archive kind so far; the SP LINK reconstruction lands beside it.
  if (!/mondo-5min/.test(archive.title))
    refuse(
      `this transformer only understands a mondo-5min archive; the manifest says "${archive.title}"`,
    );
  const mapping: ColumnMapping[] = MONDO_5MIN;

  // 🛑 A window inside a declared whole-day gap is a refusal, not an empty result. The archive says
  // the vendor had nothing there; producing zero rows would look identical to "the mapping missed".
  for (const g of archive.gaps)
    if (!(end < g.from || start > g.to))
      refuse(
        `${start}..${end} overlaps a gap the archive declares (${g.from}..${g.to}) — ` +
          `the vendor has nothing there, so there is nothing to import`,
      );

  // --- the points -------------------------------------------------------------------------------
  const pointsDoc = JSON.parse(fs.readFileSync(pointsFile, "utf8")) as {
    points?: PointRow[];
  };
  const points = pointsDoc.points ?? [];
  if (points.length === 0) refuse(`${pointsFile} lists no points`);

  const resolved = new Map<string, PointRow>();
  for (const m of mapping) {
    const hits = resolveMatcher(points, m.match);
    // Exactly one. Zero means the point does not exist yet (mint it first); more than one means the
    // matcher is ambiguous and picking either would be a guess nothing downstream could detect.
    if (hits.length === 0)
      refuse(
        `no point for column "${m.source}" (${describeMatcher(m.match)}) in ${pointsFile}`,
      );
    if (hits.length > 1)
      refuse(
        `column "${m.source}" (${describeMatcher(m.match)}) matches ${hits.length} points: ` +
          hits.map((h) => h.id).join(", "),
      );
    resolved.set(m.source, hits[0]);
  }

  // --- the rows ---------------------------------------------------------------------------------
  // One file per local calendar year, and a UTC window can straddle two of them.
  const years = [...new Set([start.slice(0, 4), end.slice(0, 4)])];
  const csvs = years
    .map((y) => path.join(sourceDir, `${y}.csv`))
    .filter((f) => fs.existsSync(f));
  if (csvs.length === 0) refuse(`no ${years.join("/")}.csv in ${sourceDir}`);

  const emitted: string[] = ["point,interval_start,value"];
  const perColumn = new Map<string, number>();
  let firstStamp: string | null = null;
  let lastStamp: string | null = null;
  // The window is expressed in whole UTC days, inclusive of both ends.
  const from = `${start}T00:00:00Z`;
  const to = `${end}T23:59:59Z`;

  for (const file of csvs) {
    const csv = readCsv(file);
    const tsIdx = csv.header.indexOf("timestamp_utc");
    if (tsIdx === -1) refuse(`${file} has no timestamp_utc column`);
    const colIdx = new Map<string, number>();
    for (const m of mapping) {
      const i = csv.header.indexOf(m.source);
      // A column the archive does not carry is a refusal, not a silent skip: the mapping describes
      // what this archive kind IS, so a missing one means the file is not what it claims.
      if (i === -1) refuse(`${file} has no "${m.source}" column`);
      colIdx.set(m.source, i);
    }

    for (const row of csv.rows) {
      const ts = row[tsIdx];
      if (ts < from || ts > to) continue;
      if (firstStamp === null || ts < firstStamp) firstStamp = ts;
      if (lastStamp === null || ts > lastStamp) lastStamp = ts;
      for (const m of mapping) {
        const raw = row[colIdx.get(m.source)!];
        // 🛑 Blank is ABSENT. No row, so the hole stays a hole.
        if (raw === undefined || raw === "") continue;
        const n = Number(raw);
        if (!Number.isFinite(n))
          refuse(`${file}: "${m.source}" at ${ts} is not a number: ${raw}`);
        const value = m.scale === undefined ? n : n * m.scale;
        emitted.push(`${resolved.get(m.source)!.id},${ts},${value}`);
        perColumn.set(m.source, (perColumn.get(m.source) ?? 0) + 1);
      }
    }
  }

  if (emitted.length === 1)
    refuse(
      `no rows in ${start}..${end} — the archive spans ${archive.coverage["Span"] ?? "?"}`,
    );

  // --- write ------------------------------------------------------------------------------------
  const csvOut = `${out}.csv`;
  const manifestOut = `${out}.manifest.json`;
  fs.writeFileSync(csvOut, `${emitted.join("\n")}\n`);

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
      files: csvs.map(fileDigest),
      declaredCoverage: archive.coverage,
    },
    device: { handle: Number.isNaN(Number(device)) ? device : Number(device) },
    window: { start: firstStamp!, end: lastStamp!, stamp: "interval_start" },
    mapping: mapping
      .filter((m) => (perColumn.get(m.source) ?? 0) > 0)
      .map((m) => {
        const p = resolved.get(m.source)!;
        return {
          source: m.source,
          point: p.id,
          logicalPath: p.logicalPath,
          physicalPath: p.physicalPath,
          unit: p.unit,
          // Only what the points file actually carries. `transform` is not in that payload, and a
          // hardcoded null beside real fields would read as a fact nobody established.
          metricType: p.metricType,
          rows: perColumn.get(m.source)!,
        };
      }),
    rows: emitted.length - 1,
  };
  fs.writeFileSync(
    manifestOut,
    `${JSON.stringify(sessionManifest, null, 2)}\n`,
  );

  const skipped = mapping.filter((m) => !perColumn.has(m.source));
  console.log(`wrote ${csvOut}  (${sessionManifest.rows} rows)`);
  console.log(`wrote ${manifestOut}`);
  console.log(`window ${firstStamp} .. ${lastStamp}  (interval_start)`);
  for (const m of sessionManifest.mapping)
    console.log(
      `  ${m.source.padEnd(22)} -> ${m.point}  ${m.logicalPath ?? "(no logical path)"}  ${m.rows} row(s)`,
    );
  // Named, not silent: a column that produced nothing is either a circuit that was not reporting or
  // a mapping that missed, and the difference matters.
  for (const m of skipped)
    console.log(
      `  ${m.source.padEnd(22)} -> no rows (blank throughout this window)`,
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
