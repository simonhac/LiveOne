/**
 * Pieces shared by the `liveone` CLI's domain modules — flag groups, ref resolution and the
 * history verb that `device` and `area` both mount.
 *
 * A COMPOSABLE module like the domains themselves: no entrypoint, nothing here talks to the
 * network except through the `ApiSession` a caller hands in.
 */
import fs from "node:fs";
import {
  EXIT,
  failWith,
  kebab,
  str,
  bool,
  V,
  type Ctx,
  type FlagSpec,
} from "@/lib/cli/cli";
import type { ApiSession } from "@/lib/cli-kit/api-session";
import { formatTime_fromJSDate } from "@/lib/date-utils";

export const usage = (what: string, why: string, next: string) =>
  failWith(EXIT.USAGE, what, why, next);

/**
 * At most one of `names` may be supplied. `names` are DECLARATION keys (`ctx.flags` is keyed by
 * them), but the message shows the kebab form, because that is what the caller typed and what the
 * parser will accept back.
 */
export function atMostOne(ctx: Ctx, names: string[]): void {
  const present = names.filter((n) => ctx.flags[n] !== undefined);
  if (present.length > 1)
    throw failWith(
      EXIT.USAGE,
      present.map((n) => `--${kebab(n)}`).join(" and "),
      "these flags are mutually exclusive",
      `pass only one of ${names.map((n) => `--${kebab(n)}`).join(", ")}`,
    );
}

/**
 * The one connection flag the http-only domains carry. Deliberately no `--via`: these verbs have
 * no db leg (their data lives behind the KV cache, the history aggregation and the flow fold, not
 * in any one table), and a flag that names a wire that does not exist is a trap.
 */
export const BASE_URL_FLAG = {
  baseUrl: {
    type: "string",
    placeholder: "origin",
    help: "Target origin (default: your stored default, else https://www.liveone.energy)",
  },
} as const satisfies Record<string, FlagSpec>;

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------

export interface RefCandidate {
  /** The TypeID, or null where the wire can degrade (the devices list can carry a null id). */
  id: string | null;
  name?: string | null;
  slug?: string | null;
  legacySystemId?: number | null;
}

/**
 * Resolve a caller-supplied ref against a caller-scoped list: exact TypeID, else the integer
 * data-addressing handle, else slug, else case-insensitive name. The same ambiguity rule as the
 * dashboard domain — >1 hit is an error naming the ids, never a silent first-match.
 */
export function resolveRef<T extends RefCandidate>(
  candidates: T[],
  ref: string,
  opts: { noun: string; listCmd: string },
): T {
  const byId = candidates.find((c) => c.id === ref);
  if (byId) return byId;
  const hits = /^\d+$/.test(ref)
    ? candidates.filter((c) => c.legacySystemId === Number(ref))
    : ((): T[] => {
        const bySlug = candidates.filter((c) => c.slug === ref);
        if (bySlug.length > 0) return bySlug;
        const lc = ref.toLowerCase();
        return candidates.filter((c) => c.name?.toLowerCase() === lc);
      })();
  if (hits.length === 0)
    throw usage(
      `no ${opts.noun} matches "${ref}"`,
      `nothing you can access has that id, handle, slug or name`,
      `run \`${opts.listCmd}\` — ids are per-environment`,
    );
  if (hits.length > 1)
    throw usage(
      `"${ref}" is ambiguous`,
      `it names ${hits.length} ${opts.noun}s you can access:\n${hits.map((h) => `  ${h.id}`).join("\n")}`,
      `address it by its id instead`,
    );
  return hits[0];
}

// ---------------------------------------------------------------------------
// The history verb (mounted by both `device` and `area`)
// ---------------------------------------------------------------------------

export const HISTORY_FLAGS = {
  interval: {
    type: "string",
    values: ["5m", "30m", "1d"],
    default: "5m",
    help: "Series resolution (range caps per request: 5m ≤ 31 days, 30m/1d ≤ 13 months)",
  },
  last: {
    type: "string",
    placeholder: "7d",
    help: "Relative window ending now, e.g. 3h, 7d (default: 1d; the server owns the grammar)",
  },
  start: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    schema: V.date,
    help: "Window start — whole LOCAL days (the subject's fixed day offset)",
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
    help:
      'Only series matching this glob, matched against the DEVICE-LESS path, e.g. "load/*", ' +
      '"**/energy.delta" (repeatable; `*` does not cross `/`)',
  },
  out: {
    type: "string",
    placeholder: "path",
    help:
      "Write the raw OpenNEM body (or the CSV, under --format csv) to this file; " +
      "stdout gets a summary",
  },
  listSeries: {
    type: "boolean",
    help:
      "List series METADATA only — id, unit, metric type, stat suffix, declared intervals, " +
      "data extents and sample count; no data arrays. The natural first call against an " +
      "unfamiliar subject. Refuses time flags; --interval is ignored (the per-series " +
      "`intervals` field answers it)",
  },
} as const satisfies Record<string, FlagSpec>;

/**
 * One series in the OpenNEM body — the fields the summary renders. The value array lives at
 * `history.data`, bounded by `history.firstInterval`/`lastInterval` (NOT `start`/`last`).
 */
interface WireSeries {
  id?: string;
  type?: string;
  units?: string;
  history?: {
    firstInterval?: string;
    lastInterval?: string;
    interval?: string;
    numIntervals?: number;
    /** Numbers for the stat series; strings for `.quality`. */
    data?: (number | string | null)[];
  };
}

interface WireHistory {
  requestStart?: string;
  requestEnd?: string;
  dataSource?: string;
  displayTimezone?: string | null;
  data?: WireSeries[];
}

/**
 * Build the `/api/history` time params from `--last | --start/--end`.
 *
 * `--start/--end` serve every interval, always as whole LOCAL days. 1d passes date-only strings —
 * the endpoint's own day vocabulary. Sub-daily sends wall-clock bounds (`YYYY-MM-DD_00.00` …
 * `_23.30`/`_23.55`, both edges inclusive) with NO offset attached: the endpoint then applies the
 * subject's own fixed offset, which is exactly "the subject's local day" without the CLI making a
 * timezone round trip. Fixed offset, deliberately not DST-aware — the same day model as the 1d
 * aggregates, so a sub-daily pull slices on the same boundaries the daily numbers roll up on.
 */
export function timeParams(
  ctx: Ctx,
  interval: string,
  defaultLast: string,
): string {
  atMostOne(ctx, ["last", "start"]);
  atMostOne(ctx, ["last", "end"]);
  const start = str(ctx, "start");
  const end = str(ctx, "end");
  if ((start === undefined) !== (end === undefined))
    throw usage(
      start === undefined ? "--end without --start" : "--start without --end",
      "an explicit window needs both edges",
      "pass both --start and --end, or use --last",
    );
  if (start === undefined || end === undefined)
    return `last=${encodeURIComponent(str(ctx, "last") ?? defaultLast)}`;
  if (end < start)
    throw usage(
      `--start=${start} --end=${end}`,
      "the end is before the start",
      "pass --end on or after --start",
    );
  if (interval === "1d") return `startTime=${start}&endTime=${end}`;
  // Inclusive edges: the last interval START of the end day (23:30 at 30m, 23:55 at 5m).
  const lastStart = interval === "30m" ? "23.30" : "23.55";
  return `startTime=${start}_00.00&endTime=${end}_${lastStart}`;
}

/** Map the route's 400s (bad `last` grammar, range over the cap, misaligned window) to USAGE. */
export const HISTORY_400 = {
  400: {
    exit: EXIT.USAGE,
    what: "the server refused the requested window",
    why: (body: Record<string, unknown>) =>
      String(body.error ?? "invalid time range"),
    next: "adjust the flags — per-request caps are 31 days at 5m, 13 months at 30m and 1d",
  },
} as const;

/**
 * `history` for one subject, in ONE request — the server's range caps are sized for this (a
 * 13-month 30m pull is a single call; use `--series` to bound the payload).
 *
 * Output shapes, so nobody has to guess them again: stdout json nests the full OpenNEM body under
 * `response`; `--out` writes the RAW body (no envelope) — or the CSV, under `--format csv`; each
 * series carries `history.{firstInterval,lastInterval,interval,numIntervals,data}`. The human
 * rendering is a per-series summary only — a long 5m payload is far too large to be read.
 * `--format csv` emits the wide CSV (see `historyCsv`); combined with `--out` the CSV goes to the
 * file and stdout gets the summary as JSON.
 */
export async function runHistoryVerb(
  ctx: Ctx,
  s: ApiSession,
  address: string,
  label: string,
): Promise<number> {
  if (bool(ctx, "listSeries")) return runListSeriesVerb(ctx, s, address, label);
  const interval = str(ctx, "interval") ?? "5m";
  const globs = (ctx.flags.series as string[] | undefined) ?? [];
  const params = [
    address,
    `interval=${interval}`,
    timeParams(ctx, interval, "1d"),
    ...(globs.length ? [`series=${encodeURIComponent(globs.join(","))}`] : []),
  ].join("&");
  const body = await s.get<WireHistory>(`/api/history?${params}`, {
    errors: HISTORY_400,
  });

  // A glob that matches nothing is an ERROR, not an empty success: the pattern grammar (device-less
  // paths) is easy to get wrong, and a silent [] reads as "no data" to a scripted caller.
  if (globs.length > 0 && (body.data ?? []).length === 0)
    throw usage(
      `--series matched no series`,
      `patterns match the path AFTER the device prefix (e.g. load/energy.delta), and \`*\` does not cross \`/\``,
      `try e.g. --series="load/*", or re-run without --series to list every id`,
    );

  const out = str(ctx, "out");
  const wantCsv = ctx.format === "csv";
  if (out !== undefined)
    fs.writeFileSync(
      out,
      wantCsv ? historyCsv(body) : JSON.stringify(body, null, 2) + "\n",
    );

  const summary = (body.data ?? []).map((d) => ({
    id: d.id ?? "?",
    type: d.type,
    units: d.units,
    samples: d.history?.data?.length ?? 0,
    start: d.history?.firstInterval,
    last: d.history?.lastInterval,
  }));
  ctx.emit(
    // Without --out the json format carries the FULL body — for history, the object is the
    // practical answer and a summary-only json would force a second fetch.
    out !== undefined
      ? { subject: label, interval, file: out, series: summary }
      : { subject: label, interval, series: summary, response: body },
    () =>
      [
        `${label}  interval=${interval}  ${body.requestStart ?? "?"} → ${body.requestEnd ?? "?"}`,
        ...summary.map(
          (r) =>
            `  ${r.id.padEnd(40)} ${String(r.samples).padStart(6)} samples  ${r.units ?? ""}`,
        ),
        out !== undefined
          ? `wrote ${out}`
          : `${summary.length} series. (--out=<path> to save the full payload, --format json to print it)`,
      ].join("\n"),
    // With --out the CSV already went to the file; the summary model has no CSV shape, so emit's
    // JSON fallback (with its stderr note) is exactly right there.
    out === undefined ? () => historyCsv(body) : undefined,
  );
  return summary.length ? EXIT.OK : EXIT.FINDINGS;
}

/** One entry of the `?list=series` response (`lib/history/list-series.ts` is the producer). */
interface WireSeriesListingEntry {
  id?: string;
  path?: string;
  label?: string;
  metricType?: string;
  aggField?: string;
  units?: string;
  intervals?: string[];
  firstData?: string | null;
  lastData?: string | null;
  samples?: number | null;
}

interface WireSeriesListing {
  list?: string;
  count?: number;
  subject?: {
    handle?: number;
    displayTimezone?: string | null;
    timezoneOffsetMin?: number;
  };
  series?: WireSeriesListingEntry[];
}

/**
 * `history --list-series`: series METADATA for a subject — no data arrays, no time range. The
 * discovery call: series ids and the stat-suffix vocabulary (`.avg/.min/.max/.last/.quality`,
 * `.delta` for energy) are otherwise only learnable by fetching data and reading the summary.
 */
async function runListSeriesVerb(
  ctx: Ctx,
  s: ApiSession,
  address: string,
  label: string,
): Promise<number> {
  // Time flags are REFUSED, not ignored — the listing has no window, and silently dropping input
  // is the kit's cardinal sin. `--interval` is the exception: it carries a default, so an explicit
  // value is indistinguishable from the defaulted one; it is documented as ignored instead.
  for (const f of ["last", "start", "end"] as const)
    if (ctx.flags[f] !== undefined)
      throw usage(
        `--${f} with --list-series`,
        "the series listing is not windowed — it covers all data",
        `drop --${f}, or drop --list-series to fetch data`,
      );

  const globs = (ctx.flags.series as string[] | undefined) ?? [];
  const params = [
    address,
    "list=series",
    ...(globs.length ? [`series=${encodeURIComponent(globs.join(","))}`] : []),
  ].join("&");
  const body = await s.get<WireSeriesListing>(`/api/history?${params}`, {
    errors: HISTORY_400,
  });
  const series = body.series ?? [];

  if (globs.length > 0 && series.length === 0)
    throw usage(
      `--series matched no series`,
      `patterns match the path AFTER the device prefix (e.g. load/energy.delta), and \`*\` does not cross \`/\``,
      `try e.g. --series="load/*", or re-run without --series to list every id`,
    );

  const out = str(ctx, "out");
  if (out !== undefined)
    fs.writeFileSync(out, JSON.stringify(body, null, 2) + "\n");

  const csv = () =>
    toCsv(
      [
        "series_id",
        "path",
        "label",
        "metric_type",
        "agg_field",
        "unit",
        "intervals",
        "first_data_local",
        "last_data_local",
        "samples",
      ],
      series.map((r) => [
        r.id,
        r.path,
        r.label,
        r.metricType,
        r.aggField,
        r.units,
        (r.intervals ?? []).join("|"),
        r.firstData,
        r.lastData,
        r.samples,
      ]),
    );

  ctx.emit(
    out !== undefined
      ? { subject: label, file: out, count: series.length }
      : body,
    () =>
      [
        `${label}  ${series.length} series${body.subject?.displayTimezone ? `  (${body.subject.displayTimezone})` : ""}`,
        ...series.map(
          (r) =>
            `  ${(r.id ?? "?").padEnd(40)} ${(r.units ?? "").padEnd(4)} ${(r.metricType ?? "").padEnd(7)} ` +
            `${(r.intervals ?? []).join(",").padEnd(6)} ` +
            (r.firstData
              ? `${r.firstData.slice(0, 10)} → ${r.lastData?.slice(0, 10) ?? "?"}  ${String(r.samples ?? "").padStart(7)} samples`
              : "(no data)"),
        ),
        out !== undefined ? `wrote ${out}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    out === undefined ? csv : undefined,
  );
  return series.length ? EXIT.OK : EXIT.FINDINGS;
}

/**
 * The CSV rendering of an OpenNEM history body — WIDE: one row per timestamp, one column per
 * series, units embedded in the header (`13/load/power.avg (W)`). Deliberately not tidy-long
 * (one row per timestamp×series): long measured ~20× the size of the source JSON for the same
 * window. One header row, so `pandas.read_csv` takes it as-is.
 *
 * Timestamps are reconstructed from each series' `firstInterval` grid — already LOCAL at the
 * subject's fixed offset, so the CLI does no timezone work beyond reading the suffix — plus the
 * same instant as UTC. Rows are a UNION across series keyed by epoch: every series today shares
 * the request-level grid, but a divergent one must land on its own timestamps, never misalign a
 * column. Nulls are empty cells.
 */
export function historyCsv(body: WireHistory): string {
  const series = body.data ?? [];
  const stepOf = (iv: string | undefined): number | null =>
    iv === "5m"
      ? 5 * 60 * 1000
      : iv === "30m"
        ? 30 * 60 * 1000
        : iv === "1d"
          ? 24 * 60 * 60 * 1000
          : null;

  const header = ["timestamp_local", "timestamp_utc"];
  const cells = new Map<number, (string | number | null)[]>();
  let offsetMin: number | null = null;

  series.forEach((d, col) => {
    header.push(d.units ? `${d.id ?? "?"} (${d.units})` : (d.id ?? "?"));
    const h = d.history;
    const step = stepOf(h?.interval);
    if (!h?.data || !h.firstInterval || step === null) return;
    const epoch0 = new Date(h.firstInterval).getTime();
    if (Number.isNaN(epoch0)) return;
    const m = /([+-])(\d{2}):(\d{2})$/.exec(h.firstInterval);
    if (m && offsetMin === null)
      offsetMin = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    h.data.forEach((v, i) => {
      const epoch = epoch0 + i * step;
      let row = cells.get(epoch);
      if (!row) {
        row = new Array<string | number | null>(series.length).fill(null);
        cells.set(epoch, row);
      }
      row[col] = v;
    });
  });

  const rows = [...cells.keys()]
    .sort((a, b) => a - b)
    .map((epoch) => [
      formatTime_fromJSDate(new Date(epoch), offsetMin ?? 0),
      new Date(epoch).toISOString().replace(".000Z", "Z"),
      ...cells.get(epoch)!,
    ]);
  return toCsv(header, rows);
}

/** Serialise rows as RFC-4180-enough CSV: quote only when needed, null/undefined → empty. */
export function toCsv(
  header: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

/** Re-exported so domain modules keep a single import for flag reading. */
export { str, bool };
