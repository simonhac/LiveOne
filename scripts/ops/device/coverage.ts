/**
 * `liveone device coverage` — how many 5-minute readings each of a device's points actually holds,
 * per local day.
 *
 * This is the verb the fleet already had and could not reach. The coverage-repair cron runs exactly
 * this count nightly (`ReadingsDao.countAgg5mByLocalDay` → `lib/coverage/find-gaps.ts`) to decide
 * what to re-fetch, but only for the three vendors whose gaps are re-fetchable, and it reports into
 * Slack. Asking it by hand meant chunked `device history` pulls (the API caps 5m at 31 days) and a
 * throwaway script to bucket the samples.
 *
 * 🛑 **Density is reported per POINT, not per series.** `soc.avg`, `soc.min` and `soc.max` are three
 * series over one point and one `agg_5m` row; `--series` globs still select in the series
 * vocabulary, but the answer is folded onto the point, because that is what was counted.
 *
 * 🛑 **`expected` is not always declared.** Cadence exists only on the three
 * `CoverageRepairProvider`s, so for a push vendor the only honest expectation is the point's own
 * best day — and the basis is printed on its own line. An invented denominator presented as a
 * vendor fact is the same mistake as an extent presented as coverage.
 */
import fs from "node:fs";
import { EXIT, V, num, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import {
  BASE_URL_FLAG,
  INCLUDE_INACTIVE_FLAG,
  bool,
  resolveDevice,
  str,
  toCsv,
  usage,
} from "../shared";
import {
  compareDensity,
  type DensityComparisonRow,
  type ExpectedBasis,
  type PointDensity,
} from "@/lib/coverage/density";

interface WireCoverage {
  device: {
    id: string;
    name: string;
    handle: number;
    vendor: string;
    status: string;
    dayOffsetMin: number;
  };
  window: { start: string; end: string; days: string[] };
  cadenceMinutes: number | null;
  expectedPerDay: number;
  expectedBasis: ExpectedBasis;
  count: number;
  points: PointDensity[];
}

const DEVICE_ARG = {
  name: "device",
  required: true,
  help: "A device: its dv_… id, integer handle, slug, or name",
} as const;

export const coverageSpec: CommandSpec = {
  name: "coverage",
  summary:
    "How many 5-minute readings each of a device's points holds, per local day.",
  when:
    "Use this for 'is this series actually complete?', and to scope a backfill before running one.\n" +
    "`device history --list-series` reports EXTENTS — the first and last row, which say nothing\n" +
    "about the interior — and this is the verb that answers density instead.",
  description:
    "--start/--end are whole LOCAL days at the device's fixed day offset (the boundaries the daily\n" +
    "aggregates roll up on); --last=Nd is whole days too. Counts are per POINT, not per series:\n" +
    "soc.avg/min/max share one point and one stored row, so --series selects and the answer folds.\n" +
    "\n" +
    "`expected` per day comes from --cadence, else the vendor's declared poll cadence (amber 30min\n" +
    "→ 48/day; openelectricity and sigenergy 5min → 288/day), else the point's own best day in the\n" +
    "window. The basis is always printed — a push vendor (fusher, gusher) declares no cadence, so\n" +
    "its expectation is `observed` and is a floor, not an authority.\n" +
    "\n" +
    "Works on a disabled or archived device with --include-inactive: coverage is exactly what you\n" +
    "ask about a device that has stopped.\n" +
    "\n" +
    "--gaps collapses the per-day table to runs of short days. --against <device> joins another\n" +
    "device's points on (logical path, metric) and diffs them day by day.\n" +
    "🛑 --against is DAY-granularity: the interval counts it reports are a LOWER BOUND on the true\n" +
    "set difference (they cancel where each side holds rows the other lacks on the same day), and\n" +
    "it never compares VALUES. For the exact rows, pull both series with\n" +
    "`device history --series … --format csv` over the days it names.",
  args: [DEVICE_ARG],
  flags: {
    ...BASE_URL_FLAG,
    ...INCLUDE_INACTIVE_FLAG,
    last: {
      type: "string",
      placeholder: "30d",
      help: "Relative window ending today, in whole days, e.g. 90d (default: 30d)",
    },
    start: {
      type: "string",
      placeholder: "YYYY-MM-DD",
      schema: V.date,
      help: "Window start — whole LOCAL days (the device's fixed day offset)",
    },
    end: {
      type: "string",
      placeholder: "YYYY-MM-DD",
      schema: V.date,
      help: "Window end, inclusive (local days)",
    },
    series: {
      type: "string",
      repeatable: true,
      placeholder: "glob",
      help: 'Only points whose series match this glob, matched against the DEVICE-LESS path, e.g. "bidi.battery/*" (repeatable; `*` does not cross `/`)',
    },
    cadence: {
      type: "number",
      placeholder: "minutes",
      help: "Override expected rows/day with a poll cadence in minutes (5 → 288/day). Use when the vendor declares none and the observed best day is wrong",
    },
    gaps: {
      type: "boolean",
      help: "Collapse the per-day table to runs of short days — the shape you act on",
    },
    against: {
      type: "string",
      placeholder: "device",
      help: "Compare with another device, joined on (logical path, metric). Day-granularity: interval counts are a LOWER BOUND, and values are never compared",
    },
    out: {
      type: "string",
      placeholder: "path",
      help: "Write the full payload (or the CSV, under --format csv) to this file; stdout gets a summary",
    },
  },
  formats: ["human", "json", "csv"],
  exitCodes: {
    1: "at least one day is short of expected (or, with --against, the two devices differ)",
  },
  examples: [
    "liveone device coverage kinkora --last=90d",
    "liveone device coverage kinkora --series='bidi.battery/soc.avg' --start=2025-09-22 --end=2026-09-15 --gaps",
    "liveone device coverage kink_fron --series='bidi.battery/soc.avg' --last=365d --against=kink_mondo",
    "liveone device coverage kinkora --last=30d --format=csv --out=coverage.csv",
  ],
  uses: ["api"],
};

// ── window ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Turn the window flags into query params.
 *
 * 🛑 `last` is passed THROUGH to the server rather than resolved here. The window is whole local
 * days at the device's fixed day offset, and that offset lives on the device — a client computing
 * "the last 90 days" would have to fetch it first and would be wrong on any device whose offset is
 * not the caller's. Whole days only: coverage has no sub-daily meaning.
 */
export function windowParams(ctx: Ctx): string {
  const start = str(ctx, "start");
  const end = str(ctx, "end");
  const last = str(ctx, "last");
  if (last !== undefined && (start !== undefined || end !== undefined))
    throw usage(
      "--last with --start/--end",
      "these name the same window two ways",
      "pass --last, or both --start and --end",
    );
  if ((start === undefined) !== (end === undefined))
    throw usage(
      start === undefined ? "--end without --start" : "--start without --end",
      "an explicit window needs both edges",
      "pass both --start and --end, or use --last",
    );
  if (start !== undefined && end !== undefined) {
    if (end < start)
      throw usage(
        `--end (${end}) is before --start (${start})`,
        "the window would be empty",
        "swap them",
      );
    return `start=${start}&end=${end}`;
  }
  const rel = last ?? "30d";
  if (!/^\d+d$/.test(rel))
    throw usage(
      `--last=${rel} is not a whole number of days`,
      "coverage is counted per local day, so the window is whole days",
      "use e.g. --last=90d, or pass --start and --end",
    );
  return `last=${rel}`;
}

async function fetchCoverage(
  s: ApiSession,
  ctx: Ctx,
  ref: string,
  window: string,
): Promise<WireCoverage> {
  const device = await resolveDevice(s, ref, {
    includeInactive: bool(ctx, "includeInactive") === true,
  });
  const globs = (ctx.flags.series as string[] | undefined) ?? [];
  const cadence = num(ctx, "cadence");
  const params = [
    window,
    ...(globs.length ? [`series=${encodeURIComponent(globs.join(","))}`] : []),
    ...(cadence !== undefined ? [`cadence=${cadence}`] : []),
  ].join("&");
  return s.get<WireCoverage>(
    `/api/v4/devices/${encodeURIComponent(device.id!)}/coverage?${params}`,
  );
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────

const n = (v: number) => v.toLocaleString("en-AU");
const pct = (v: number | null) => (v === null ? "   —  " : `${v.toFixed(1)}%`);

const BASIS_WHY: Record<WireCoverage["expectedBasis"], string> = {
  flag: "from --cadence",
  vendor: "the vendor's declared poll cadence",
  // Named plainly: this is a floor derived from the data itself, not a fact about the instrument.
  observed:
    "the best day among these points — no cadence is declared for this vendor",
  none: "UNKNOWN",
};

/**
 * 🛑 No cadence declared AND nothing in the window to infer one from.
 *
 * This is not "0 expected, therefore nothing missing, therefore complete" — it is "no expectation
 * could be formed, and the device produced nothing". A naive renderer prints those identically, and
 * they mean opposite things: the second is precisely the condition this verb exists to surface, a
 * push vendor gone dark, which no cron, alert or other command reports.
 */
const noEvidence = (c: WireCoverage) => c.expectedBasis === "none";

/** The verdict line — the ONE place the word "complete" may be said. */
function verdict(c: WireCoverage, shortPoints: number): string[] {
  if (c.count === 0) return ["no points matched — nothing was checked."];
  if (noEvidence(c))
    return [
      `🛑 ${c.count} point(s) checked and NOT ONE holds a single row in this window.`,
      "   This is not a clean result: with no declared cadence there is no expectation to",
      "   measure against, so nothing here can be called complete. Pass --cadence to state",
      "   what this device should produce, or widen the window to find its last data.",
    ];
  return [
    shortPoints === 0
      ? `${c.count} point(s) checked — every day is complete at ${n(c.expectedPerDay)}/day.`
      : `${shortPoints} of ${c.count} point(s) have short days.`,
  ];
}

function header(c: WireCoverage): string[] {
  return [
    `${c.device.name} (${c.device.id})${c.device.status === "active" ? "" : `  [${c.device.status}]`}`,
    `  window    ${c.window.start} → ${c.window.end}  (${c.window.days.length} days)`,
    noEvidence(c)
      ? `  expected  UNKNOWN — no cadence is declared for vendor '${c.device.vendor}', and this window holds NO rows to infer one from`
      : `  expected  ${n(c.expectedPerDay)}/day — ${BASIS_WHY[c.expectedBasis]}`,
    "",
  ];
}

function renderGaps(c: WireCoverage): string {
  const lines = header(c);
  let shortPoints = 0;
  for (const p of c.points) {
    if (p.gaps.length === 0) continue;
    shortPoints += 1;
    lines.push(
      `  ${p.logicalPath ?? "?"}/${p.metricType}   ${pct(p.coveragePct)}   ${n(p.total)} / ${n(p.expectedTotal)}`,
    );
    for (const g of p.gaps)
      lines.push(
        `      ${g.start} → ${g.end}   ${String(g.days).padStart(4)} day${g.days === 1 ? " " : "s"}   ${n(g.present)} / ${n(g.expected)}`,
      );
  }
  lines.push("", ...verdict(c, shortPoints));
  return lines.join("\n");
}

function renderDense(c: WireCoverage): string {
  const lines = header(c);
  if (c.points.length === 0) lines.push("  (no points matched)");
  for (const p of c.points)
    lines.push(
      `  ${(p.logicalPath ?? "?") + "/" + p.metricType}`.padEnd(46) +
        `${pct(p.coveragePct).padStart(7)}   ${n(p.total).padStart(9)} / ${n(p.expectedTotal).padEnd(9)}  ` +
        (p.firstDay ? `${p.firstDay} → ${p.lastDay}` : "(empty)") +
        (p.gaps.length ? `   ${p.gaps.length} gap(s)` : ""),
    );
  const short = c.points.filter((p) => p.gaps.length > 0).length;
  lines.push(
    "",
    ...verdict(c, short),
    ...(short > 0 && !noEvidence(c)
      ? ["re-run with --gaps to see the runs."]
      : []),
  );
  return lines.join("\n");
}

/** Long format, one row per (point, day) — the shape a spreadsheet or a script wants. */
export function densityCsv(c: WireCoverage): string {
  const rows: (string | number)[][] = [];
  for (const p of c.points)
    c.window.days.forEach((day, i) =>
      rows.push([
        p.pointId,
        p.logicalPath ?? "",
        p.metricType,
        day,
        p.counts[i] ?? 0,
        c.expectedPerDay,
        // The basis travels WITH the number. Without it a consumer cannot tell a vendor cadence
        // from an operator override from a high-water mark inferred from the data itself — and
        // `none` from a genuine zero.
        c.expectedBasis,
      ]),
    );
  return toCsv(
    [
      "point_id",
      "logical_path",
      "metric_type",
      "day",
      "count",
      "expected",
      "expected_basis",
    ],
    rows,
  );
}

/** One row per gap run. */
export function gapsCsv(c: WireCoverage): string {
  const rows: (string | number)[][] = [];
  for (const p of c.points)
    for (const g of p.gaps)
      rows.push([
        p.pointId,
        p.logicalPath ?? "",
        p.metricType,
        g.start,
        g.end,
        g.days,
        g.present,
        g.expected,
        c.expectedBasis,
      ]);
  return toCsv(
    [
      "point_id",
      "logical_path",
      "metric_type",
      "start",
      "end",
      "days",
      "present",
      "expected",
      "expected_basis",
    ],
    rows,
  );
}

/**
 * The `--against` rendering.
 *
 * 🛑 Every interval number here is prefixed `≥`, and the footnote is not optional. `Σ max(0, b − a)`
 * per day cancels wherever both sides hold rows the other lacks on the SAME day, so it under-counts
 * the true set difference. Printing it bare would be the exact failure this whole verb exists to
 * stop: a number that reads as more than it measured.
 */
export function renderComparison(
  a: WireCoverage,
  b: WireCoverage,
  rows: DensityComparisonRow[],
): string {
  const lines = [
    `A  ${a.device.name} (${a.device.id})`,
    `B  ${b.device.name} (${b.device.id})`,
    `   ${a.window.start} → ${a.window.end}  (${a.window.days.length} days)`,
    "",
  ];
  for (const r of rows) {
    lines.push(`  ${r.key}`);
    if (!r.a) lines.push("      not present on A");
    if (!r.b) lines.push("      not present on B");
    lines.push(
      `      A ${n(r.a?.total ?? 0).padStart(9)}   B ${n(r.b?.total ?? 0).padStart(9)}`,
      `      days B leads ${String(r.daysOnlyB).padStart(4)}   ≥ ${n(r.intervalsBLacksInA)} intervals B has that A lacks`,
      `      days A leads ${String(r.daysOnlyA).padStart(4)}   ≥ ${n(r.intervalsALacksInB)} intervals A has that B lacks`,
    );
  }
  lines.push(
    "",
    "≥ because these are DAY counts: where each side holds rows the other lacks on the same day",
    "the two shortfalls cancel here, so the true set difference is at least this large. For the",
    "exact intervals, pull both series with `device history --series … --format csv`.",
    "Values are never compared — coverage counts rows, it does not read them.",
  );
  return lines.join("\n");
}

export function comparisonCsv(rows: DensityComparisonRow[]): string {
  return toCsv(
    [
      "key",
      "a_total",
      "b_total",
      "days_b_leads",
      "days_a_leads",
      "min_intervals_b_has_a_lacks",
      "min_intervals_a_has_b_lacks",
    ],
    rows.map((r) => [
      r.key,
      r.a?.total ?? 0,
      r.b?.total ?? 0,
      r.daysOnlyB,
      r.daysOnlyA,
      r.intervalsBLacksInA,
      r.intervalsALacksInB,
    ]),
  );
}

// ── handler ─────────────────────────────────────────────────────────────────────────────────────

export async function runCoverage(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const window = windowParams(ctx);
    const wantGaps = bool(ctx, "gaps");
    const against = str(ctx, "against");
    const out = str(ctx, "out");
    const wantCsv = ctx.format === "csv";

    const a = await fetchCoverage(s, ctx, ctx.args[0], window);

    if (against !== undefined) {
      // 🛑 The SECOND call is pinned to the first's resolved window, not to the flags. Under
      // `--last` the two calls would otherwise each resolve "today" against their own device's day
      // offset, and a one-day skew between them would show up as a phantom difference on the edge.
      const b = await fetchCoverage(
        s,
        ctx,
        against,
        `start=${a.window.start}&end=${a.window.end}`,
      );
      // 🛑 Refuse, rather than report a difference that is an artefact of bucketing. Each side is
      // counted in ITS OWN device's local day, so two devices on different offsets can hold the
      // identical set of intervals and still disagree per day — readings at 23:30Z and 00:30Z are
      // [1,1] at UTC and [0,2] at UTC+1. That would make the "intervals B has that A lacks" figure
      // report a discrepancy where there is none, which is worse than declining to answer.
      if (a.device.dayOffsetMin !== b.device.dayOffsetMin)
        throw usage(
          `${a.device.name} and ${b.device.name} bucket days differently`,
          `their fixed day offsets are ${a.device.dayOffsetMin} and ${b.device.dayOffsetMin} minutes, so a per-day comparison would report bucketing as disagreement`,
          "compare devices that share a day offset, or read each one separately with `device coverage`",
        );
      const rows = compareDensity(a.points, b.points);
      const differs = rows.some(
        (r) => r.intervalsBLacksInA > 0 || r.intervalsALacksInB > 0,
      );
      const model = {
        a: { ...a.device, window: a.window },
        b: { ...b.device, window: b.window },
        granularity: "day",
        note: "interval counts are a LOWER BOUND on the set difference; values are not compared",
        comparison: rows.map((r) => ({ ...r, a: undefined, b: undefined })),
      };
      const csv = wantCsv ? comparisonCsv(rows) : null;
      if (out !== undefined) {
        fs.writeFileSync(out, csv ?? JSON.stringify(model, null, 2) + "\n");
        ctx.note(`wrote ${out}`);
      }
      ctx.emit(
        model,
        () => renderComparison(a, b, rows),
        () => csv ?? "",
      );
      return differs ? EXIT.FINDINGS : EXIT.OK;
    }

    const csv = wantCsv ? (wantGaps ? gapsCsv(a) : densityCsv(a)) : null;
    if (out !== undefined) {
      fs.writeFileSync(out, csv ?? JSON.stringify(a, null, 2) + "\n");
      ctx.note(`wrote ${out}`);
    }
    ctx.emit(
      a,
      () => (wantGaps ? renderGaps(a) : renderDense(a)),
      () => csv ?? "",
    );
    // Findings, not OK, for all three of: short days, a window in which the device produced
    // nothing (`basis: "none"` — no expectation could be formed, so "complete" is unsayable), and
    // no matching points at all. A scripted check must not read any of those as a pass.
    const findings =
      a.count === 0 ||
      a.expectedBasis === "none" ||
      a.points.some((p) => p.gaps.length > 0);
    return findings ? EXIT.FINDINGS : EXIT.OK;
  });
}
