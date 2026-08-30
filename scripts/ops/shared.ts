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
  type Ctx,
  type FlagSpec,
} from "@/lib/cli/cli";
import type { ApiSession } from "@/lib/cli-kit/api-session";

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
    help: "Series resolution (range caps: 5m ≤ 7.5 days, 30m ≤ 30 days, 1d ≤ 13 months)",
  },
  last: {
    type: "string",
    placeholder: "7d",
    help: "Relative window ending now, e.g. 3h, 7d (default: 1d; the server owns the grammar)",
  },
  start: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    help: "Window start (1d interval only; whole local days)",
  },
  end: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    help: "Window end, inclusive (1d interval only)",
  },
  series: {
    type: "string",
    repeatable: true,
    placeholder: "glob",
    help: "Only series matching this glob (repeatable)",
  },
  out: {
    type: "string",
    placeholder: "path",
    help: "Write the full OpenNEM JSON to this file; stdout gets a summary",
  },
} as const satisfies Record<string, FlagSpec>;

/** What one series looks like in the OpenNEM body — only what the summary renders. */
interface WireSeries {
  id?: string;
  type?: string;
  units?: string;
  history?: { start?: string; last?: string; data?: unknown[] };
}

interface WireHistory {
  requestStart?: string;
  requestEnd?: string;
  dataSource?: string;
  data?: WireSeries[];
}

/**
 * Validate the time flags and render them as `/api/history` query params.
 *
 * `--start/--end` are 1d-only ON PURPOSE: sub-daily windows need boundary-aligned instants in the
 * subject's timezone, which the CLI cannot know without another round trip — `--last` sidesteps
 * the whole trap and is what an operator wants anyway. Exported for the `flows` verb, which is
 * always 1d.
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
  if (start !== undefined && end !== undefined) {
    if (interval !== "1d")
      throw usage(
        `--start/--end with --interval=${interval}`,
        "explicit dates address whole local days, which only the 1d interval serves",
        "use --interval=1d, or a relative --last window",
      );
    return `startTime=${start}&endTime=${end}`;
  }
  return `last=${encodeURIComponent(str(ctx, "last") ?? defaultLast)}`;
}

/** Map the route's 400s (bad `last` grammar, range over the cap, misaligned window) to USAGE. */
export const HISTORY_400 = {
  400: {
    exit: EXIT.USAGE,
    what: "the server refused the requested window",
    why: (body: Record<string, unknown>) =>
      String(body.error ?? "invalid time range"),
    next: "adjust the flags — caps are 7.5 days at 5m, 30 days at 30m, 13 months at 1d",
  },
} as const;

/**
 * `history` for one subject. The full OpenNEM body goes to `--out` (or, as json, to stdout); the
 * human rendering is a per-series summary ONLY — a 7-day 5m payload is far too large to be read,
 * and an agent that wants the arrays should ask for the file.
 */
export async function runHistoryVerb(
  ctx: Ctx,
  s: ApiSession,
  address: string,
  label: string,
): Promise<number> {
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

  const out = str(ctx, "out");
  if (out !== undefined)
    fs.writeFileSync(out, JSON.stringify(body, null, 2) + "\n");

  const summary = (body.data ?? []).map((d) => ({
    id: d.id ?? "?",
    type: d.type,
    units: d.units,
    samples: d.history?.data?.length ?? 0,
    start: d.history?.start,
    last: d.history?.last,
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
  );
  return summary.length ? EXIT.OK : EXIT.FINDINGS;
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
