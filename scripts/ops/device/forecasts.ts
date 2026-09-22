/**
 * `liveone device forecasts` — what Amber PUBLISHED, and whether the logger capturing it was alive.
 *
 * Reads `amber_forecast_history` over `GET /api/v4/devices/{id}/forecasts`. Until this existed the
 * only way in was a minted prod database role, which is how the September 2026 forecast-accuracy
 * analysis had to be done. `scripts/amber/forecast-accuracy.ts` now gets its data from here.
 *
 * Three shapes, one per request:
 *
 *   (default)   per channel and lead, the revision IN FORCE at each interval's cutoff — the last
 *               stored row at or before `interval_end − lead` (or `interval_start − lead` under
 *               `--anchor start`). The table is change-only, so "in force" may mean "observed hours
 *               earlier and not moved since".
 *   --as-of     the whole curve as published at one instant, every channel incl. `site` (spot,
 *               renewables).
 *   --health    polls vs captures, horizon, and each gap between captures attributed against
 *               `sessions` — a silent capture outage and an unchanging forecast look identical in a
 *               change-only table, and only the poll record tells them apart.
 *
 * Truth (the settled price) is not here: it is an ordinary series,
 * `device history <amber> --interval 30m --series 'bidi.grid.import/rate.avg'`.
 */
import fs from "node:fs";
import { EXIT, V, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import type {
  WireAsOfRow,
  WireCaptureHealth,
  WireInForceChannel,
} from "@/lib/vendors/amber/forecast-wire";
import {
  BASE_URL_FLAG,
  bool,
  resolveDevice,
  str,
  toCsv,
  usage,
} from "../shared";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const AEST_OFFSET_MS = 10 * HOUR_MS; // fixed +10, no DST — Amber's nemTime basis

export const forecastsSpec = {
  name: "forecasts",
  summary:
    "Amber's published price forecasts: the revision in force N hours out, the curve as of an instant, or capture health.",
  when:
    "Use this to ask what Amber was forecasting for an interval, how far ahead, and whether the\n" +
    "forecast logger was running. For the price that actually SETTLED, use `device history`\n" +
    "(`--series 'bidi.grid.import/rate.avg'`).",
  description:
    "Amber devices only (422 otherwise).\n" +
    "\n" +
    "Default: per channel, the captured interval set, and per --lead the revision in force at\n" +
    "each interval's cutoff. --anchor end (default) measures the lead to the interval END;\n" +
    "--anchor start to its START, which is how a decision is framed. Amber's intervals are 30\n" +
    "minutes, so start-anchored lead L is end-anchored L + 0.5 — the same data, relabelled.\n" +
    "\n" +
    "--start/--end are AEST calendar days (fixed +10, no DST), inclusive, at most 62 days;\n" +
    "--last=Nd ends today (AEST). --lead takes a list or ranges, e.g. 0.5,1-24 (at most 48).\n" +
    "\n" +
    "--as-of <ISO> returns the curve as published at that instant over --horizon hours (default\n" +
    "48), every channel including `site` (spot price and renewables).\n" +
    "\n" +
    "--health reports polls (from `sessions`) against captures, the horizon reach, and every gap\n" +
    "between captures over 7 minutes with its cause: no poll ran, polls failed, or polls ran and\n" +
    "Amber's forecast moved less than the storage threshold.\n" +
    "\n" +
    "--format csv is LONG: one row per (channel, lead, interval) — or per gap under --health.",
  args: [
    {
      name: "device",
      required: true,
      help: "An Amber device: its dv_… id, integer handle, slug, or name",
    },
  ],
  flags: {
    ...BASE_URL_FLAG,
    start: {
      type: "string",
      placeholder: "YYYY-MM-DD",
      schema: V.date,
      help: "Window start — an AEST calendar day",
    },
    end: {
      type: "string",
      placeholder: "YYYY-MM-DD",
      schema: V.date,
      help: "Window end, inclusive (AEST)",
    },
    last: {
      type: "string",
      placeholder: "7d",
      help: "Window of whole AEST days ending today (default 7d)",
    },
    channel: {
      type: "string",
      repeatable: true,
      values: ["general", "feedIn", "controlledLoad"],
      help: "Channel(s) to read (default general + feedIn)",
    },
    lead: {
      type: "string",
      placeholder: "1-12",
      help: "Lead hours: a list and/or ranges, e.g. 1,2,6 or 0.5,1-24 (default 1-12)",
    },
    anchor: {
      type: "string",
      values: ["end", "start"],
      help: "Measure the lead to the interval end (default) or start",
    },
    asOf: {
      type: "string",
      placeholder: "ISO",
      help: "Instead: the curve as published at this instant",
    },
    horizon: {
      type: "number",
      placeholder: "hours",
      help: "With --as-of: how far ahead of it to read (default 48, max 72)",
    },
    health: {
      type: "boolean",
      help: "Instead: capture health over the window",
    },
    out: {
      type: "string",
      placeholder: "path",
      help: "Also write the full payload (or the CSV, under --format csv) to this file",
    },
  },
  formats: ["human", "json", "csv"],
  exitCodes: {
    1: "nothing was captured in the window (or, with --as-of, nothing was in force)",
  },
  examples: [
    "liveone device forecasts amber --last=7d --lead=1,6,12",
    "liveone device forecasts amber --start=2026-08-15 --end=2026-09-21 --lead=0.5,1-24 --anchor=start --format=json --out=fc.json",
    "liveone device forecasts amber --health --last=3d",
    "liveone device forecasts amber --as-of=2026-09-20T06:00:00Z --format=csv",
  ],
  uses: ["api"],
} satisfies CommandSpec;

// ── wire ────────────────────────────────────────────────────────────────────────────────────────

interface WireWindow {
  start: string;
  end: string;
  from: string;
  to: string;
}
interface InForceBody {
  deviceId: string;
  window: WireWindow;
  anchor: "end" | "start";
  leads: number[];
  channels: WireInForceChannel[];
}
interface HealthBody {
  deviceId: string;
  window: WireWindow;
  health: WireCaptureHealth;
}
interface AsOfBody {
  deviceId: string;
  at: string;
  horizon: number;
  rows: WireAsOfRow[];
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────

/** AEST wall-clock for an ISO instant — Amber's own basis, so intervals read as Amber labels them. */
export function aest(isoOrMs: string | number, withSeconds = false): string {
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  const s = new Date(ms + AEST_OFFSET_MS).toISOString();
  return withSeconds
    ? s.slice(0, 19).replace("T", " ")
    : s.slice(0, 16).replace("T", " ");
}

/** The console preamble the accuracy script prints — kept here so the two cannot drift. */
export function renderHealth(h: WireCaptureHealth): string {
  const lines = ["CAPTURE HEALTH"];
  if (h.rows === 0) {
    lines.push("  ✗ no forecast rows captured in this window.");
    return lines.join("\n");
  }
  const firstMs = Date.parse(h.firstObservedAt!);
  const lastMs = Date.parse(h.lastObservedAt!);
  const spanHours = Math.max((lastMs - firstMs) / HOUR_MS, 1 / 60);
  lines.push(
    `  ${h.polls} polls run over ${spanHours.toFixed(1)}h ` +
      `(${(h.polls / spanHours).toFixed(2)}/h vs ${h.expectedPollsPerHour}/h nominal, ` +
      `mean spacing ${((spanHours * 60) / Math.max(h.polls, 1)).toFixed(2)} min)` +
      (h.failedPolls > 0 ? `  ⚠ ${h.failedPolls} failed` : ""),
  );
  if (h.failedPolls > 0 && h.topError)
    lines.push(`      most common error: ${h.topError}`);
  lines.push(
    `  ${h.captures} captures (${h.polls - h.captures} poll(s) recorded nothing), ` +
      `${h.rows.toLocaleString()} rows, ${(h.rows / Math.max(h.captures, 1)).toFixed(1)} rows/capture`,
    `  observed ${aest(h.firstObservedAt!, true)} → ${aest(h.lastObservedAt!, true)}  (newest row ${h.newestAgeMin} min old)`,
    `  targets  ${aest(h.minTarget!)} → ${aest(h.maxTarget!)}`,
    `  horizon  ${(h.horizonMinHours ?? NaN).toFixed(1)}h … ${(h.horizonMaxHours ?? NaN).toFixed(1)}h ahead of the poll`,
  );
  if (h.gaps.length === 0) {
    lines.push(`  no capture gaps > ${h.gapThresholdMin} min ✓`);
  } else {
    const lostMin = h.gaps.reduce((s, g) => s + g.gapMin, 0);
    lines.push(
      `  ⚠ ${h.gaps.length} capture gap(s) > ${h.gapThresholdMin} min (${lostMin.toFixed(0)} min):`,
    );
    for (const g of h.gaps.slice(0, 10)) {
      const verdict =
        g.verdict === "cron-missed"
          ? "no poll ran — cron tick(s) missed"
          : g.verdict === "failed"
            ? `${g.pollsInside} poll(s) ran, ${g.failedInside} failed: ${g.reason ?? "unknown"}`
            : `${g.pollsInside} poll(s) ran and captured nothing (sub-threshold)`;
      lines.push(
        `      ${aest(g.prev, true)} → ${aest(g.next, true)}  ${g.gapMin.toFixed(1)} min — ${verdict}`,
      );
    }
    if (h.gaps.length > 10)
      lines.push(`      … and ${h.gaps.length - 10} more`);
  }
  lines.push("", "  channel         type    rows  targets  w/price   w/band");
  for (const b of h.breakdown)
    lines.push(
      `  ${b.channel.padEnd(15)} ${b.intervalType.padEnd(4)} ` +
        `${b.rows.toLocaleString().padStart(7)}  ${String(b.targets).padStart(7)}  ` +
        `${String(b.withPrice).padStart(7)}  ${String(b.withBand).padStart(7)}`,
    );
  return lines.join("\n");
}

function renderInForce(b: InForceBody): string {
  const lines = [
    `window ${b.window.start} → ${b.window.end} AEST · lead anchored to interval ${b.anchor.toUpperCase()}`,
  ];
  for (const c of b.channels) {
    lines.push(
      "",
      `${c.channel} — ${c.captured.length} intervals captured`,
      "   lead  in-force  w/price  w/band  spike≠none  median staleness",
    );
    for (const l of c.leads) {
      const staleness = l.rows
        .map((r) => {
          const end = Date.parse(r.intervalEnd);
          const anchorMs =
            b.anchor === "start" ? end - r.durationMin * 60_000 : end;
          return (
            (anchorMs - l.lead * HOUR_MS - Date.parse(r.observedAt)) / 60_000
          );
        })
        .sort((x, y) => x - y);
      const median = staleness.length
        ? `${staleness[Math.floor(staleness.length / 2)].toFixed(0)} min`
        : "—";
      lines.push(
        `  ${String(l.lead).padStart(4)}h  ${String(l.rows.length).padStart(8)}  ` +
          `${String(l.rows.filter((r) => r.perKwh !== null).length).padStart(7)}  ` +
          `${String(l.rows.filter((r) => r.advPredicted !== null).length).padStart(6)}  ` +
          `${String(l.rows.filter((r) => r.spikeStatus && r.spikeStatus !== "none").length).padStart(10)}  ` +
          `${median.padStart(16)}`,
      );
    }
  }
  return lines.join("\n");
}

const inForceCsv = (b: InForceBody) =>
  toCsv(
    [
      "channel",
      "lead_hours",
      "interval_end",
      "observed_at",
      "duration_min",
      "per_kwh",
      "adv_low",
      "adv_predicted",
      "adv_high",
      "descriptor",
      "spike_status",
      "interval_type",
    ],
    b.channels.flatMap((c) =>
      c.leads.flatMap((l) =>
        l.rows.map((r) => [
          c.channel,
          l.lead,
          r.intervalEnd,
          r.observedAt,
          r.durationMin,
          r.perKwh,
          r.advLow,
          r.advPredicted,
          r.advHigh,
          r.descriptor,
          r.spikeStatus,
          r.intervalType,
        ]),
      ),
    ),
  );

function renderAsOf(b: AsOfBody): string {
  if (!b.rows.length) return `nothing in force at ${b.at}.`;
  const lines = [
    `as published at ${aest(b.at, true)} AEST, next ${b.horizon}h`,
    "",
    "  interval end       channel          type  per_kwh  adv_pred  descriptor      spike      spot  renew%",
  ];
  const f = (v: number | null, w: number) =>
    (v === null ? "" : v.toFixed(2)).padStart(w);
  for (const r of b.rows)
    lines.push(
      `  ${aest(r.intervalEnd)}   ${r.channel.padEnd(15)}  ${r.intervalType.padEnd(4)}  ` +
        `${f(r.perKwh, 7)}  ${f(r.advPredicted, 8)}  ${(r.descriptor ?? "").padEnd(14)}  ` +
        `${(r.spikeStatus ?? "").padEnd(9)}  ${f(r.spotPerKwh, 6)}  ${f(r.renewables, 6)}`,
    );
  return lines.join("\n");
}

const asOfCsv = (b: AsOfBody) =>
  toCsv(
    [
      "channel",
      "interval_end",
      "observed_at",
      "duration_min",
      "interval_type",
      "per_kwh",
      "adv_low",
      "adv_predicted",
      "adv_high",
      "descriptor",
      "spike_status",
      "spot_per_kwh",
      "renewables",
    ],
    b.rows.map((r) => [
      r.channel,
      r.intervalEnd,
      r.observedAt,
      r.durationMin,
      r.intervalType,
      r.perKwh,
      r.advLow,
      r.advPredicted,
      r.advHigh,
      r.descriptor,
      r.spikeStatus,
      r.spotPerKwh,
      r.renewables,
    ]),
  );

const healthCsv = (b: HealthBody) =>
  toCsv(
    [
      "prev_capture",
      "next_capture",
      "gap_min",
      "polls_inside",
      "failed_inside",
      "verdict",
      "reason",
    ],
    b.health.gaps.map((g) => [
      g.prev,
      g.next,
      g.gapMin,
      g.pollsInside,
      g.failedInside,
      g.verdict,
      g.reason,
    ]),
  );

// ── window ──────────────────────────────────────────────────────────────────────────────────────

/** `--start/--end` or `--last=Nd` (default 7d) → AEST days. Amber's day is fixed +10, so no device lookup. */
function aestDays(ctx: Ctx): { start: string; end: string } {
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
  if (start !== undefined && end !== undefined) return { start, end };
  const m = /^(\d+)d$/.exec(last ?? "7d");
  if (!m || Number(m[1]) < 1)
    throw usage(
      `--last=${last} is not a whole number of days`,
      "the window is whole AEST days",
      "use e.g. --last=7d, or pass --start and --end",
    );
  const todayMs = Date.now() + AEST_OFFSET_MS;
  return {
    start: new Date(todayMs - (Number(m[1]) - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10),
    end: new Date(todayMs).toISOString().slice(0, 10),
  };
}

// ── handler ─────────────────────────────────────────────────────────────────────────────────────

export async function runForecasts(ctx: Ctx): Promise<number> {
  const asOf = str(ctx, "asOf");
  const health = bool(ctx, "health");
  if (asOf !== undefined && health)
    throw usage(
      "--as-of with --health",
      "they are different reads",
      "pass one of them",
    );
  const out = str(ctx, "out");
  const wantCsv = ctx.format === "csv";

  return withApiSession(ctx, async (s) => {
    const device = await resolveDevice(s, ctx.args[0]);
    const base = `/api/v4/devices/${encodeURIComponent(device.id!)}/forecasts`;
    const q = new URLSearchParams();

    let body: InForceBody | HealthBody | AsOfBody;
    let human: () => string;
    let csv: () => string;
    let findings: boolean;

    if (asOf !== undefined) {
      if (!Number.isFinite(Date.parse(asOf)))
        throw usage(
          `--as-of=${asOf} is not a timestamp`,
          "it must parse as an ISO instant",
          "e.g. --as-of=2026-09-20T06:00:00Z",
        );
      q.set("mode", "as-of");
      q.set("at", asOf);
      const horizon = ctx.flags.horizon as number | undefined;
      if (horizon !== undefined) q.set("horizon", String(horizon));
      const b = await s.get<AsOfBody>(`${base}?${q}`);
      body = b;
      human = () => renderAsOf(b);
      csv = () => asOfCsv(b);
      findings = b.rows.length === 0;
    } else {
      const { start, end } = aestDays(ctx);
      q.set("start", start);
      q.set("end", end);
      if (health) {
        q.set("mode", "health");
        const b = await s.get<HealthBody>(`${base}?${q}`);
        body = b;
        human = () => renderHealth(b.health);
        csv = () => healthCsv(b);
        findings = b.health.rows === 0;
      } else {
        for (const c of (ctx.flags.channel as string[] | undefined) ?? [])
          q.append("channel", c);
        const lead = str(ctx, "lead");
        if (lead) q.set("lead", lead);
        const anchor = str(ctx, "anchor");
        if (anchor) q.set("anchor", anchor);
        const b = await s.get<InForceBody>(`${base}?${q}`);
        body = b;
        human = () => renderInForce(b);
        csv = () => inForceCsv(b);
        findings = b.channels.every((c) => c.captured.length === 0);
      }
    }

    if (out !== undefined) {
      fs.writeFileSync(
        out,
        wantCsv ? csv() : JSON.stringify(body, null, 2) + "\n",
      );
      ctx.note(`wrote ${out}`);
    }
    ctx.emit(body, human, csv);
    return findings ? EXIT.FINDINGS : EXIT.OK;
  });
}
