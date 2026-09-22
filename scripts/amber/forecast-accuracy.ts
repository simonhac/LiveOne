#!/usr/bin/env tsx
/**
 * Amber price-forecast accuracy — how wrong is Amber's published forecast, N hours out?
 *
 * Scores what Amber PUBLISHED (`amber_forecast_history`, the change-only capture added by #373/#374)
 * against the settled price for the same interval, per lead time. It also prints a CAPTURE HEALTH
 * preamble first, because every number below it is worthless if the logger stopped: a silent capture
 * outage and a genuinely unchanging forecast look identical in a change-only table, and only the
 * poll cadence tells them apart.
 *
 * Read-only, over the deployed API as you — every byte comes from the `liveone` CLI
 * (`device forecasts` for what was published and the capture health, `device history` for the
 * settled price), so there is no database connection and no credential beyond your CLI token.
 * `npm run liveone -- auth login` first (for prod: `--base-url https://www.liveone.energy`).
 *
 * Conventions that matter:
 *   - **`--anchor` (default `end`) picks which end of the interval the lead is measured to.**
 *     `end`: "6h out" = published at or before `interval_end − 6h`. `start`: 6h before the
 *     half-hour BEGINS, which is how a decision is framed ("what will the price be for the
 *     half-hour starting at 8pm"). `cutoffMsFor` in lib/vendors/amber/forecast-accuracy.ts owns it.
 *     ⚠️ Amber's intervals are uniformly 30 minutes, so the two anchors differ by exactly that:
 *     start-anchored at lead L is end-anchored at L + 0.5, the SAME curve shifted half an hour.
 *     Use it because it labels the axis with the question you are actually asking, not because it
 *     is a second measurement.
 *   - **Truth** is the settled 5m-aggregate price for the same `interval_end`, preferring `b`
 *     (billable, final) over `a` (actual). Both tables key on Amber's `nemTime`, so the join is
 *     plain equality — no timezone arithmetic.
 *   - **Coverage** is `paired / targets`, where targets = intervals that were captured AND have
 *     settled truth. An interval with no forecast at that lead was outside Amber's horizon (or
 *     predates the capture); it lowers coverage rather than being scored as a hit or a miss.
 *   - `--start`/`--end` are AEST calendar days (fixed +10, no DST), inclusive.
 *   - `--leads` (default `1-12`) is what gets COMPUTED; `--summary-leads` (default `1,2,6,12`) is
 *     only what reaches the console table. Every computed lead lands in the CSV, the JSON and the
 *     chart, because the shape of error against lead is the interesting output and a 12-row grid
 *     per channel is not how anyone reads a shape.
 *
 * Usage:
 *   npm run amber:forecast-accuracy -- --device=9 --base-url=https://www.liveone.energy
 *   npm run amber:forecast-accuracy -- --device=9 --days=7 --leads=1-12
 *   npm run amber:forecast-accuracy -- --device=9 --leads=1-24 --summary-leads=1,6,12,24
 *   npm run amber:forecast-accuracy -- --device=9 --start=2026-08-15 --end=2026-08-21 --csv=.context/afa.csv
 *   npm run amber:forecast-accuracy -- --device=9 --anchor=start
 *   npm run amber:forecast-accuracy -- --device=9 --health-only
 *   npm run amber:forecast-accuracy -- --device=9 --no-chart --json
 *
 * `--device` is any device ref the CLI accepts (dv_… id, handle, slug or name). `--base-url` is
 * passed straight through; without it the CLI's own default origin applies.
 *
 * ⚠️ Truth arrives through `/api/history`, which rounds values to 4 significant figures, so an
 * MAE here can differ from a direct-DB computation in the third decimal place.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";

import type {
  AccuracySummary,
  ForecastObservation,
  SettledActual,
  SkillScore,
} from "@/lib/vendors/amber/forecast-accuracy";
import {
  pairForecastsWithActuals,
  parseLeads,
  persistenceSkill,
  scoreableTargets,
  selectTruth,
  summarisePairs,
  truthDisagreements,
} from "@/lib/vendors/amber/forecast-accuracy";
import type { LeadAnchor } from "@/lib/vendors/amber/forecast-accuracy";
import {
  MAX_IN_FORCE_ROWS,
  type WireCaptureHealth,
  type WireInForceChannel,
} from "@/lib/vendors/amber/forecast-wire";
import { renderHealth } from "../ops/device/forecasts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const AEST_OFFSET_MS = 10 * HOUR_MS; // fixed +10, no DST — Amber's nemTime basis

/**
 * Amber `channelType` → the logical series its settled price is served as, plus how to name it.
 *
 * `short` is for the chart legend only. Amber's own wire names are what the console sections and
 * the CSV's `channel` column use, because that column is a KEY — it joins back to
 * `amber_forecast_history.channel` — and renaming it would break that for the sake of prettier
 * output. Presentation gets the readable name; data keeps the vendor's.
 */
const CHANNEL_POINTS: Record<
  string,
  { stem: string; label: string; short: string }
> = {
  general: { stem: "bidi.grid.import", label: "grid import", short: "import" },
  feedIn: {
    stem: "bidi.grid.export",
    label: "grid export (feed-in)",
    short: "export",
  },
  controlledLoad: {
    stem: "bidi.grid.controlled",
    label: "controlled load",
    short: "ctrl load",
  },
};

interface Args {
  device: string;
  baseUrl?: string;
  leads: number[];
  /** Subset of `leads` shown in the console table; the CSV/JSON/chart always carry all of them. */
  summaryLeads: number[];
  days: number;
  start?: string;
  end?: string;
  channels: string[];
  maxStalenessMin?: number;
  csv?: string;
  csvPairs?: string;
  chart: string | null;
  json: boolean;
  healthOnly: boolean;
  anchor: LeadAnchor;
}

function anchorOf(v: string | undefined): LeadAnchor {
  if (v === undefined || v === "end") return "end";
  if (v === "start") return "start";
  throw new Error(`--anchor must be 'end' or 'start' (got '${v}')`);
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const has = (name: string) => argv.includes(`--${name}`);

  const leads = parseLeads(get("leads") ?? "1-12");
  if (leads.length === 0) throw new Error("--leads must list positive hours");

  // Which leads reach the CONSOLE table. Every computed lead still lands in the CSV, the JSON and
  // the chart — the table is a reading aid, and a 12-row grid per channel is one to skim past
  // rather than read. Leads not in the computed set are silently ignored, so narrowing `--leads`
  // does not require also narrowing this.
  const summaryLeads = parseLeads(get("summary-leads") ?? "1,2,6,12").filter(
    (l) => leads.includes(l),
  );

  const channels = (get("channels") ?? "general,feedIn")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of channels) {
    if (!CHANNEL_POINTS[c]) {
      throw new Error(
        `unknown channel '${c}' (expected ${Object.keys(CHANNEL_POINTS).join(", ")})`,
      );
    }
  }

  const device = get("device");
  if (!device)
    throw new Error(
      "--device=<ref> is required (a dv_… id, handle, slug or name — `npm run liveone -- device list`)",
    );
  const maxStaleness = get("max-staleness-min");

  return {
    device,
    baseUrl: get("base-url"),
    leads,
    summaryLeads,
    days: Number(get("days") ?? 7),
    start: get("start"),
    end: get("end"),
    channels,
    maxStalenessMin:
      maxStaleness === undefined ? undefined : Number(maxStaleness),
    csv: get("csv"),
    csvPairs: get("csv-pairs"),
    chart: has("no-chart")
      ? null
      : (get("chart") ?? ".context/amber-forecast-accuracy.png"),
    json: has("json"),
    healthOnly: has("health-only"),
    anchor: anchorOf(get("anchor")),
  };
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────

/** AEST wall-clock for a UTC epoch — Amber's own basis, so intervals read as Amber labels them. */
function aest(ms: number, withSeconds = false): string {
  const iso = new Date(ms + AEST_OFFSET_MS).toISOString();
  return withSeconds
    ? iso.slice(0, 19).replace("T", " ")
    : iso.slice(0, 16).replace("T", " ");
}

function num(v: number, dp = 2, width = 6): string {
  return (Number.isFinite(v) ? v.toFixed(dp) : "—").padStart(width);
}

function pct(v: number, width = 5): string {
  return (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "—").padStart(
    width,
  );
}

/** AEST calendar day 'YYYY-MM-DD' → the UTC epoch of its 00:00 boundary. */
function aestDayStartMs(day: string): number {
  const ms = Date.parse(`${day}T00:00:00+10:00`);
  if (!Number.isFinite(ms))
    throw new Error(`bad date '${day}' (expected YYYY-MM-DD)`);
  return ms;
}

/** The AEST calendar day `YYYY-MM-DD` that `ms` falls in. */
function aestDay(ms: number): string {
  return new Date(ms + AEST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────

const execFileP = promisify(execFile);

/**
 * Run one `liveone` command and parse its JSON stdout.
 *
 * Exit 1 is FINDINGS in the CLI's vocabulary ("ran fine, the answer is empty or negative"), so its
 * payload is still returned; any other non-zero exit is fatal and becomes this script's exit code,
 * with the CLI's stderr passed through so the reason is not lost.
 */
async function runLiveone<T>(
  args: string[],
  baseUrl: string | undefined,
): Promise<{ body: T; code: number }> {
  const argv = [
    "tsx",
    "scripts/ops/liveone.ts",
    ...args,
    ...(baseUrl ? ["--base-url", baseUrl] : []),
    "--format",
    "json",
    "--quiet",
  ];
  try {
    const { stdout } = await execFileP("npx", argv, {
      maxBuffer: 512 * 1024 * 1024,
    });
    return { body: JSON.parse(stdout) as T, code: 0 };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    if (err.code === 1 && err.stdout)
      return { body: JSON.parse(err.stdout) as T, code: 1 };
    process.stderr.write(err.stderr ?? "");
    const failure = new Error(
      `liveone ${args.slice(0, 3).join(" ")} … exited ${err.code ?? "?"}`,
    ) as Error & { exitCode?: number };
    failure.exitCode = typeof err.code === "number" ? err.code : 1;
    throw failure;
  }
}

/** Run `fns` with at most `limit` in flight — each is a whole CLI process plus a server request. */
async function pooled<T>(
  fns: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const out: T[] = new Array(fns.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, fns.length) }, async () => {
      while (next < fns.length) {
        const i = next++;
        out[i] = await fns[i]();
      }
    }),
  );
  return out;
}

interface HistorySeries {
  path: string;
  history: {
    firstInterval: string;
    interval: string;
    data: (number | string | null)[];
  };
}
interface HistoryBody {
  subject: string;
  response: { data: HistorySeries[] };
}

/**
 * The settled price for one channel, from `device history --interval 30m`.
 *
 * `/api/history` stamps each value at its interval END (`firstInterval` is the end of the first
 * bucket), which is Amber's `nemTime` — the same key `amber_forecast_history.interval_end` uses — so
 * the join stays plain equality. The avg and quality series are separate series over one point.
 */
function settledFromHistory(
  body: HistoryBody,
  channel: string,
): SettledActual[] {
  const stem = CHANNEL_POINTS[channel].stem;
  const find = (field: string) =>
    body.response.data.find((d) => d.path === `${stem}/rate.${field}`);
  const avg = find("avg");
  const quality = find("quality");
  if (!avg || !quality)
    throw new Error(
      `no settled-price series for channel ${channel} (expected ${stem}/rate.avg and .quality)`,
    );
  const stepMs = avg.history.interval === "30m" ? 30 * 60_000 : NaN;
  if (!Number.isFinite(stepMs))
    throw new Error(`expected 30m history, got ${avg.history.interval}`);
  const qualityAt = new Map<number, string>();
  const qFirst = Date.parse(quality.history.firstInterval);
  quality.history.data.forEach((q, i) => {
    if (typeof q === "string") qualityAt.set(qFirst + i * stepMs, q);
  });
  const first = Date.parse(avg.history.firstInterval);
  const out: SettledActual[] = [];
  avg.history.data.forEach((v, i) => {
    const intervalEndMs = first + i * stepMs;
    const q = qualityAt.get(intervalEndMs);
    if (typeof v !== "number" || q === undefined) return;
    out.push({ intervalEndMs, value: v, quality: q });
  });
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cli = <T>(argv: string[]) => runLiveone<T>(argv, args.baseUrl);

  // ── window: whole AEST days (the route's unit) ─────────────────────────────
  const endDay = args.end ?? aestDay(Date.now());
  const startDay =
    args.start ?? aestDay(aestDayStartMs(endDay) - (args.days - 1) * DAY_MS);
  const fromMs = aestDayStartMs(startDay);
  const toMs = aestDayStartMs(endDay) + DAY_MS;
  if (fromMs >= toMs) throw new Error("empty window (--start is after --end)");
  const window = ["--start", startDay, "--end", endDay];

  // ── capture health ─────────────────────────────────────────────────────────
  const health = await cli<{ deviceId: string; health: WireCaptureHealth }>([
    "device",
    "forecasts",
    args.device,
    "--health",
    ...window,
  ]);

  // ── truth: settled prices, via `device history` ────────────────────────────
  // Reach back an extra day so the persistence baseline (same half-hour yesterday) exists for the
  // first intervals in the window — and forward one, because a local day's history stops at the
  // 23:30 interval END, so the interval ending at the window's closing midnight lives in the next
  // day. The surplus is clipped off again below.
  const history = await cli<HistoryBody>([
    "device",
    "history",
    args.device,
    "--interval",
    "30m",
    "--start",
    aestDay(fromMs - DAY_MS),
    "--end",
    aestDay(toMs),
    ...args.channels.flatMap((c) => [
      "--series",
      `${CHANNEL_POINTS[c].stem}/rate.avg`,
      "--series",
      `${CHANNEL_POINTS[c].stem}/rate.quality`,
    ]),
  ]);
  const deviceName = history.body.subject;

  console.log(
    `\nAmber forecast accuracy — ${deviceName}\n` +
      `window ${aest(fromMs)} → ${aest(toMs)} AEST  (all times AEST, prices c/kWh incl GST)\n` +
      `lead anchored to interval ${args.anchor.toUpperCase()}` +
      (args.anchor === "start"
        ? " — i.e. N hours before the half-hour BEGINS"
        : " — i.e. N hours before the half-hour FINISHES"),
  );
  console.log("\n" + renderHealth(health.body.health));
  if (health.body.health.rows === 0) process.exitCode = 1;
  if (args.healthOnly) return;

  // ── published forecasts: one channel per request, leads split to fit the row budget ──
  // Every captured interval can yield one row per lead, and the route refuses a request whose
  // `captured × leads` exceeds MAX_IN_FORCE_ROWS — so size the lead chunks from the window.
  const windowDays = Math.round((toMs - fromMs) / DAY_MS);
  const leadsPerCall = Math.max(
    1,
    Math.floor(MAX_IN_FORCE_ROWS / (windowDays * 48 + 1)),
  );
  const leadChunks: number[][] = [];
  for (let i = 0; i < args.leads.length; i += leadsPerCall)
    leadChunks.push(args.leads.slice(i, i + leadsPerCall));

  const inForce = new Map<
    string,
    { captured: number[]; byLead: Map<number, ForecastObservation[]> }
  >();
  const calls = args.channels.flatMap((channel) =>
    leadChunks.map((chunk) => async () => {
      const { body } = await cli<{ channels: WireInForceChannel[] }>([
        "device",
        "forecasts",
        args.device,
        ...window,
        "--channel",
        channel,
        "--lead",
        chunk.join(","),
        "--anchor",
        args.anchor,
      ]);
      return { channel, read: body.channels[0] };
    }),
  );
  for (const { channel, read } of await pooled(calls, 4)) {
    let entry = inForce.get(channel);
    if (!entry)
      inForce.set(
        channel,
        (entry = {
          captured: read.captured.map((t) => Date.parse(t)),
          byLead: new Map(),
        }),
      );
    for (const l of read.leads)
      entry.byLead.set(
        l.lead,
        l.rows.map(
          (r): ForecastObservation => ({
            intervalEndMs: Date.parse(r.intervalEnd),
            observedAtMs: Date.parse(r.observedAt),
            durationMin: r.durationMin,
            perKwh: r.perKwh,
            advLow: r.advLow,
            advPredicted: r.advPredicted,
            advHigh: r.advHigh,
          }),
        ),
      );
  }

  // ── per-channel scoring ───────────────────────────────────────────────────
  const summaries: {
    channel: string;
    lead: number;
    summary: AccuracySummary;
    skill: SkillScore | null;
  }[] = [];
  const pairRows: string[] = [
    "channel,lead_hours,interval_end_aest,observed_at_aest,staleness_min,forecast,actual,error,adv_predicted,in_band",
  ];

  for (const channel of args.channels) {
    // Clipped to the span the truth line has always described: the window plus its lead-in day.
    const readings = settledFromHistory(history.body, channel).filter(
      (r) => r.intervalEndMs >= fromMs - DAY_MS && r.intervalEndMs <= toMs,
    );
    const truth = selectTruth(readings);
    const disagree = truthDisagreements(readings);

    const published = inForce.get(channel)!;
    const targets = scoreableTargets(published.captured, truth);
    const settledCount = { b: 0, a: 0 } as Record<string, number>;
    for (const t of truth.values())
      settledCount[t.quality] = (settledCount[t.quality] ?? 0) + 1;

    console.log(
      `\n${channel.toUpperCase()} — ${CHANNEL_POINTS[channel].label}\n` +
        `  truth: ${truth.size} settled intervals (${
          Object.entries(settledCount)
            .map(([q, n]) => `${n} ${q}`)
            .join(", ") || "none"
        }); ` +
        `a/b disagree on ${disagree.differing} of ${disagree.compared} restated\n` +
        `  ${targets} scoreable target intervals (captured + settled)`,
    );

    if (targets === 0) {
      console.log("  nothing to score in this window.");
      for (const lead of args.leads) {
        summaries.push({
          channel,
          lead,
          summary: summarisePairs([], 0),
          skill: null,
        });
      }
      continue;
    }

    console.log(
      `\n  ${args.leads.length} leads computed; showing ${args.summaryLeads.join("/")}h ` +
        `(all of them are in the CSV, the JSON and the chart)`,
    );
    console.log(
      "\n  lead  paired  cover     MAE    bias    RMSE     p50     p90     max  band%  advMAE  skill  staleP90",
    );

    for (const lead of args.leads) {
      const revisions = published.byLead.get(lead) ?? [];

      const pairs = pairForecastsWithActuals(revisions, truth, lead, {
        maxStalenessMin: args.maxStalenessMin,
        anchor: args.anchor,
      });
      const summary = summarisePairs(pairs, targets);
      const skill = persistenceSkill(pairs, truth);
      summaries.push({ channel, lead, summary, skill });

      if (args.summaryLeads.includes(lead)) {
        console.log(
          `  ${String(lead).padStart(3)}h  ${String(summary.paired).padStart(6)}  ` +
            `${pct(summary.coverage)}  ${num(summary.mae, 2, 6)}  ${num(summary.bias, 2, 6)}  ` +
            `${num(summary.rmse, 2, 6)}  ${num(summary.p50AbsError, 2, 6)}  ` +
            `${num(summary.p90AbsError, 2, 6)}  ${num(summary.maxAbsError, 2, 6)}  ` +
            `${pct(summary.bandCoverage)}  ${num(summary.advPredictedMae, 2, 6)}  ` +
            `${num(skill?.skill ?? NaN, 2, 5)}  ${num(summary.p90StalenessMin, 1, 8)}`,
        );
      }

      for (const p of pairs) {
        pairRows.push(
          [
            channel,
            lead,
            aest(p.intervalEndMs),
            aest(p.observedAtMs, true),
            p.stalenessMin.toFixed(1),
            p.forecast,
            p.actual,
            p.error.toFixed(4),
            p.advPredicted ?? "",
            p.inBand === null ? "" : p.inBand,
          ].join(","),
        );
      }
    }

    const withSkill = summaries.filter((s) => s.channel === channel && s.skill);
    if (withSkill.length) {
      console.log(
        `  skill is vs persistence (same half-hour yesterday), MAE ` +
          `${withSkill[0].skill!.maePersistence.toFixed(2)} c/kWh over ${withSkill[0].skill!.n} intervals; ` +
          `>0 means Amber beats it.`,
      );
    }
  }

  // ── artefacts ─────────────────────────────────────────────────────────────
  if (args.csv) {
    const header =
      "channel,lead_hours,targets,paired,coverage,mae,bias,rmse,p50_abs_error,p90_abs_error," +
      "max_abs_error,sd_abs_error,sd_error,se_error,band_coverage,adv_predicted_mae,skill," +
      "persistence_mae,p50_staleness_min,p90_staleness_min,max_staleness_min";
    const body = summaries.map(({ channel, lead, summary: s, skill }) =>
      [
        channel,
        lead,
        s.targets,
        s.paired,
        s.coverage,
        s.mae,
        s.bias,
        s.rmse,
        s.p50AbsError,
        s.p90AbsError,
        s.maxAbsError,
        s.sdAbsError,
        s.sdError,
        s.seError,
        s.bandCoverage,
        s.advPredictedMae,
        skill?.skill ?? "",
        skill?.maePersistence ?? "",
        s.p50StalenessMin,
        s.p90StalenessMin,
        s.maxStalenessMin,
      ]
        .map((v) => (typeof v === "number" && !Number.isFinite(v) ? "" : v))
        .join(","),
    );
    writeOut(args.csv, [header, ...body].join("\n") + "\n");
  }
  if (args.csvPairs) writeOut(args.csvPairs, pairRows.join("\n") + "\n");
  if (args.json) console.log(JSON.stringify(summaries, null, 2));

  if (args.chart) {
    const { renderAccuracyChart } = await import("./forecast-accuracy-chart");
    const written = await renderAccuracyChart(args.chart, {
      title: `Amber forecast error vs lead — ${deviceName}`,
      subtitle: `${aest(fromMs)} → ${aest(toMs)} AEST · lead anchored to interval ${args.anchor}`,
      footnote:
        args.anchor === "start"
          ? "Lead time before the half-hour begins. Higher error at longer lead = the forecast improves as the interval approaches."
          : "Lead time before the half-hour ends. Higher error at longer lead = the forecast improves as the interval approaches.",
      series: args.channels.map((channel) => ({
        channel: CHANNEL_POINTS[channel].short,
        points: summaries
          .filter(
            (s) => s.channel === channel && Number.isFinite(s.summary.mae),
          )
          .map((s) => ({
            lead: s.lead,
            mae: s.summary.mae,
            p90: s.summary.p90AbsError,
            bias: s.summary.bias,
            maeSd: s.summary.sdAbsError,
            biasSe: s.summary.seError,
          })),
      })),
    });
    for (const f of written) console.log(`\nwrote ${f}`);
  }
}

function writeOut(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`\nwrote ${path}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit((e as { exitCode?: number }).exitCode ?? 1);
  },
);
