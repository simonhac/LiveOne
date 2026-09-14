/**
 * The `device` domain of the `liveone` CLI — the physical/vendor layer: what a device is, what it
 * reports, and what it reported over time.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * Http-only: every verb calls the deployed API as you, against the same readable set the web app
 * serves.
 *
 * Read-only except for two verbs, both about the rows computed FROM a device's readings
 * (`agg_1d`, the per-Area flow matrix). `recompute` rebuilds them for a window that has changed
 * underneath them — its subject is a device and its window is whatever a repair touched, so it lives
 * here rather than in a domain of its own; `liveone sync` publishes the readings and points at it by
 * name. `change-offset` moves the day BOUNDARY those rows roll up on, which invalidates all of them
 * at once, and so rebuilds the device's whole history rather than a window.
 *
 * The `config` sub-group (./config.ts) is the other writer: it normalises the stored `DeviceConfig`
 * jsonb, which is how a config key deleted from the code finally leaves the database.
 */
import {
  defineCommand,
  EXIT,
  V,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import {
  BASE_URL_FLAG,
  HISTORY_FLAGS,
  listDevices,
  resolveArea,
  resolveDevice,
  runHistoryVerb,
  str,
  usage,
  type WireDevice,
} from "../shared";
import { configSpec, CONFIG_HANDLERS } from "./config";

const DEVICE_ARG = {
  name: "device",
  required: true,
  help: "A device: its dv_… id, integer handle, slug, or name",
} as const;

interface WirePoint {
  id: string;
  physicalPath: string;
  logicalPath: string | null;
  metricType: string;
  unit: string | null;
  name: string;
  subsystem: string | null;
  active: boolean;
  control: unknown;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export const deviceCommand = defineCommand({
  name: "device",
  summary:
    "Inspect devices — config, metadata, points, latest values, history.",
  when:
    "Reach for this for the PHYSICAL/vendor layer: what a device IS and what it reports. For the\n" +
    "semantic grouping (areas, bindings, flows) use `area`; for what a dashboard shows use\n" +
    "`dashboard`.",
  description:
    "Http-only: every verb calls the deployed API as you (`liveone auth login`), and prints\n" +
    "`target: <origin> as <you>` on stderr first — read it to know which environment answered.\n" +
    "Ids are per-environment.\n\n" +
    "Every verb here READS except `recompute`, `change-offset` and `area`, which write and are\n" +
    "dry-run by default.",
  uses: ["api"],
  subcommands: {
    list: {
      name: "list",
      summary:
        "List the devices you can read: id, handle, vendor, status, name.",
      when: "Start here when you do not yet know a device's id.",
      flags: {
        ...BASE_URL_FLAG,
        vendor: {
          type: "string",
          placeholder: "vendor",
          help: "Only this vendor's devices",
        },
        status: {
          type: "string",
          placeholder: "status",
          help: "Only devices with this status (active, disabled, removed)",
        },
      },
      examples: ["liveone device list", "liveone device list --vendor=amber"],
    },
    show: {
      name: "show",
      summary:
        "A device's full aggregate: metadata, config, adapter state, capabilities, points.",
      when:
        "Use this to see everything the platform knows about one device — its vendor identity,\n" +
        "config overrides, derived capabilities and point inventory.",
      description:
        "The aggregate is an OBJECT, so the human rendering is the pretty-printed JSON — a table\n" +
        "would only hide its shape. `points` renders the point inventory alone, as a table.\n" +
        "`capabilities` are DERIVED (a point scan + compound predicates), and `area show` remains\n" +
        "the authoritative place to read them in context — its members carry the same list.",
      args: [DEVICE_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: [
        "liveone device show daylesford",
        "liveone device show dv_01kybrhzkmfyxvz63d15rscj19",
      ],
    },
    points: {
      name: "points",
      summary: "A device's point inventory: pt_… id, path, metric, unit.",
      when:
        "Use this to find a point's id or path — e.g. before wiring a binding or reading a\n" +
        "specific series.",
      args: [DEVICE_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone device points daylesford"],
    },
    latest: {
      name: "latest",
      summary: "The device's current values, from the serving cache.",
      when:
        "Use this for 'what is it doing NOW' — the same latest map every dashboard card reads.\n" +
        "For anything with a time axis use `history`.",
      args: [DEVICE_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone device latest daylesford"],
    },
    history: {
      name: "history",
      summary:
        "Time series for a device, in the OpenNEM shape /api/history serves.",
      when:
        "Use this to pull a device's measured series over a window. The human rendering is a\n" +
        "per-series summary; the full payload goes to --out (or --format json).",
      description:
        "--start/--end are whole LOCAL days (the device's fixed day offset — the same boundaries\n" +
        "the daily aggregates roll up on). One request regardless of span; bound long sub-daily\n" +
        "pulls with --series. Shapes: --format json nests the full OpenNEM body under `response`;\n" +
        "--out writes the RAW body; each series carries\n" +
        "history.{firstInterval,lastInterval,interval,numIntervals,data}.\n" +
        "--format csv emits WIDE rows — timestamp_local, timestamp_utc, then one column per\n" +
        "series with the unit in the header (`13/load/power.avg (W)`); nulls are empty cells.\n" +
        "With --out the CSV goes to the file and stdout gets the summary (as JSON).",
      args: [DEVICE_ARG],
      flags: { ...BASE_URL_FLAG, ...HISTORY_FLAGS },
      formats: ["human", "json", "csv"],
      exitCodes: {
        1: "no series matched (the window, or the --list-series subject)",
      },
      examples: [
        "liveone device history daylesford --list-series",
        "liveone device history daylesford --last=3h",
        'liveone device history daylesford --last=7d --series="load/*" --format=csv --out=load.csv',
        "liveone device history daylesford --interval=1d --start=2026-07-01 --end=2026-07-31",
      ],
    },
    config: configSpec,
    recompute: {
      name: "recompute",
      summary:
        "Rebuild the rows derived FROM a device's readings, over a window of local days.",
      when:
        "Run this AFTER a `liveone sync` (or any other repair) has landed, for the same window.\n" +
        "Derived rows are pure functions of their sources and nothing rebuilds a past day on its\n" +
        "own, so a backfill without this leaves the dashboards showing the hole it just filled.\n" +
        "For RUN DETECTORS — generator runs, EV charge sessions — use `derivation recompute`\n" +
        "instead; they are derivations and are rebuilt by their own scoped verb.",
      description:
        "Rebuilds `agg_1d` for each day, then the attributed flow matrix of every Area the\n" +
        "device's points bind into, re-folding the battery blend first where the Area has one.\n\n" +
        "SCOPED, deliberately: it does not run the fleet-wide HWS, battery-learning and backlog\n" +
        "reheal passes that `/api/cron/daily` does. Those exist to find days that went stale for\n" +
        "reasons unconnected to this repair, and sweeping the fleet's backlog is the nightly\n" +
        "sweep's job — measured on prod, a one-day backfill spent an entire 300s budget in it.\n\n" +
        "🛑 The window is REQUIRED and capped at 31 days. There is no unscoped form and no\n" +
        "'absent means everything': the fleet-wide twin reads a missing date as ALL HISTORY, and a\n" +
        "verb whose dangerous case is the one you get by typing less will eventually be typed\n" +
        "less. Days are the DEVICE's local days — the boundaries its daily aggregates roll up on.",
      mutates: true,
      args: [DEVICE_ARG],
      flags: {
        ...BASE_URL_FLAG,
        date: {
          type: "string",
          placeholder: "YYYY-MM-DD",
          schema: V.date,
          help: "A single local day",
        },
        start: {
          type: "string",
          placeholder: "YYYY-MM-DD",
          schema: V.date,
          help: "Window start (local days)",
        },
        end: {
          type: "string",
          placeholder: "YYYY-MM-DD",
          schema: V.date,
          help: "Window end, inclusive (local days)",
        },
      },
      examples: [
        "liveone device recompute kutis --date=2026-09-10",
        "liveone device recompute 13 --start=2026-09-10 --end=2026-09-11 --apply",
      ],
    },
    "change-offset": {
      name: "change-offset",
      summary:
        "Move a device's fixed day offset, and re-bucket every daily aggregate rolled up on the old one.",
      when:
        "Run this when a device's stored offset is simply WRONG — most often a daylight-saving\n" +
        "offset frozen in as though it were the fixed standard one, so the device's days roll over\n" +
        "an hour off from the area it feeds. This is the only sanctioned way to change the offset:\n" +
        "editing it anywhere else moves the label and leaves the data on the old boundary.",
      description:
        "Writes the device's `day_offset_min` and its own area's offset, deletes the `agg_1d` rows\n" +
        "that were rolled up on the old boundary, and rebuilds them on the new one — then refreshes\n" +
        "the flow matrix of every Area the device's points bind into.\n\n" +
        "🛑 There is NO window flag, deliberately. Changing the boundary invalidates every day the\n" +
        "device ever rolled up, so the window is the whole history and is measured from the data\n" +
        "rather than typed. A partial re-bucket would split the device's days across two boundaries\n" +
        "with nothing recording where the seam is.\n\n" +
        "🛑 Refuses when the device's OWN area — the one minted alongside it — holds other devices,\n" +
        "because its offset moves with the device and a shared area would re-bucket its other\n" +
        "members as collateral. Being a member of a multi-device site is fine and expected: the\n" +
        "site area's own offset is not touched.\n\n" +
        "The daily totals WILL change — that is the point. Run detectors are not covered; rebuild\n" +
        "those with `liveone derivation recompute`.",
      mutates: true,
      args: [DEVICE_ARG],
      flags: {
        ...BASE_URL_FLAG,
        offset: {
          type: "string",
          placeholder: "MINUTES",
          help: "The new fixed day offset in minutes east of UTC (e.g. 600 for AEST)",
        },
      },
      examples: [
        "liveone device change-offset 'Kinkora Fronius' --offset=600",
        "liveone device change-offset 5 --offset=600 --apply",
      ],
    },
    area: {
      name: "area",
      summary: "Put a device in an area, or in none.",
      when:
        "Reach for this when you know the DEVICE and want to say where it lives. The inverse —\n" +
        "stating an area's whole membership — is `liveone area devices`; both exist because both\n" +
        "questions are natural and neither is a one-request rewrite of the other.",
      description:
        "🛑 A device is in AT MOST ONE area, so this is a MOVE. The device leaves whatever area it\n" +
        "was in, and THAT area loses every binding whose point lives on this device — which can\n" +
        "blank a card or a Sankey somewhere you were not looking. The dry run names both ends.\n\n" +
        "`--none` takes the device out of every area, leaving it AMBIENT. That is a real state, not\n" +
        "a broken one: an ambient device is still polled, still aggregated and still readable by\n" +
        "handle — it simply has no area, so no flow matrix and no grid card. The OpenElectricity\n" +
        "NEM regions live there permanently, and are refused by this verb for that reason.",
      mutates: true,
      args: [
        DEVICE_ARG,
        {
          name: "area",
          required: false,
          help: "The destination area: ar_… id, integer handle, or display name. Omit with --none.",
        },
      ],
      flags: {
        ...BASE_URL_FLAG,
        none: {
          type: "boolean",
          help: "Take the device out of every area, leaving it ambient",
        },
      },
      exitCodes: { 1: "the server refused the move (the reason says why)" },
      examples: [
        "liveone device area 'Kutis' kew",
        "liveone device area 'Kutis' kew --apply",
        "liveone device area 13 --none --apply",
      ],
    },
  },
} satisfies CommandSpec);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const vendor = str(ctx, "vendor");
    const status = str(ctx, "status");
    const devices = (await listDevices(s)).filter(
      (d) =>
        (vendor === undefined || d.vendor === vendor) &&
        (status === undefined || d.status === status),
    );
    ctx.emit({ count: devices.length, devices }, () =>
      [
        ...devices.map(
          (d) =>
            `${d.id ?? "(no id)"}  handle=${String(d.legacySystemId).padEnd(8)} ` +
            `${d.vendor.padEnd(10)} ${d.status.padEnd(9)} ` +
            `${d.slug ? `slug=${d.slug}  ` : ""}${d.name}`,
        ),
        "",
        `${devices.length} device(s).`,
      ].join("\n"),
    );
    return devices.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

async function fetchAggregate(
  s: ApiSession,
  ref: string,
): Promise<Record<string, unknown> & { points?: WirePoint[] }> {
  const device = await resolveDevice(s, ref);
  return s.get(
    `/api/v4/devices/${encodeURIComponent(device.id!)}?include=points,capabilities`,
  );
}

async function runShow(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const body = await fetchAggregate(s, ctx.args[0]);
    // Object-heavy payload: the pretty JSON IS the human rendering (a table would hide the shape).
    ctx.emit(body, () => JSON.stringify(body, null, 2));
    return EXIT.OK;
  });
}

async function runPoints(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const body = await fetchAggregate(s, ctx.args[0]);
    const points = body.points ?? [];
    ctx.emit(
      {
        device: { id: body.id, name: body.name },
        count: points.length,
        points,
      },
      () =>
        [
          ...points.map(
            (p) =>
              `${p.id}  ${p.active ? " " : "✗"} ${p.metricType.padEnd(12)} ` +
              `${(p.unit ?? "").padEnd(6)} ${p.logicalPath ?? p.physicalPath}` +
              (p.control ? "  [controllable]" : ""),
          ),
          "",
          `${points.length} point(s). (✗ = inactive)`,
        ].join("\n"),
    );
    return points.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

async function runLatest(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const device = await resolveDevice(s, ctx.args[0]);
    const body = await s.get<Record<string, unknown>>(
      `/api/data?deviceId=${encodeURIComponent(device.id!)}`,
    );
    ctx.emit(body, () =>
      [
        `${device.name} (${device.id}) — latest:`,
        JSON.stringify(body, null, 2),
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

async function runHistory(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const device = await resolveDevice(s, ctx.args[0]);
    return runHistoryVerb(
      ctx,
      s,
      `deviceId=${encodeURIComponent(device.id!)}`,
      `${device.name} (${device.id})`,
    );
  });
}

/** What `POST /api/v4/devices/{id}/recompute` answers. */
export interface WireRecompute {
  device: { id: string; systemId: number; name: string; vendor: string };
  window: { start: string; end: string; days: number };
  dayOffsetMin: number;
  days: string[];
  dryRun: boolean;
  agg1dDays: number;
  provenanceAreas: number;
}

/**
 * 🛑 The counts are a MEASUREMENT, not the request echoed back. `recomputeDerivedForDeviceDays` is
 * best-effort per day and per Area — a failure on one is logged server-side and the rest proceed —
 * so `agg1dDays` short of the days asked for is the only signal that some of them did not rebuild,
 * and it has to read as a shortfall rather than as a total.
 */
export function renderRecompute(r: WireRecompute): string {
  const out = [
    `device       ${r.device.systemId}  ${r.device.name}  (${r.device.vendor})`,
    `window       ${r.window.start} → ${r.window.end}   (${r.window.days} local day${
      r.window.days === 1 ? "" : "s"
    }, offset ${r.dayOffsetMin >= 0 ? "+" : ""}${r.dayOffsetMin}m)`,
  ];

  if (r.dryRun) {
    out.push(
      "",
      `would rebuild agg_1d for ${r.days.length} day(s), then the flow matrix of every Area`,
      "this device's points bind into. Nothing has been rebuilt.",
      "(dry run — pass --apply to write)",
    );
    return out.join("\n");
  }

  out.push(
    "",
    `agg_1d       ${r.agg1dDays} of ${r.days.length} day(s) rebuilt`,
    `flow         ${r.provenanceAreas} area(s) refreshed`,
  );
  if (r.agg1dDays < r.days.length)
    out.push(
      "",
      `${r.days.length - r.agg1dDays} day(s) did NOT rebuild. The recompute is best-effort per day,`,
      "so the rest proceeded; the reason is in the server logs.",
    );
  out.push(
    "",
    "Run detectors are NOT covered here — rebuild those with `liveone derivation recompute`.",
  );
  return out.join("\n");
}

async function runRecompute(ctx: Ctx): Promise<number> {
  const date = str(ctx, "date");
  const start = str(ctx, "start");
  const end = str(ctx, "end");

  if (date && (start || end))
    throw usage(
      "--date with --start/--end",
      "they are alternatives: one day, or a range",
      "drop --date, or drop the range",
    );
  // 🛑 Both ends or neither. A lone --start would otherwise have to mean something, and every
  // meaning available ("to today", "that day alone") is a window the caller did not type.
  if (!date && !(start && end))
    throw usage(
      "no window",
      "a recompute is a delete-and-reinsert, so it always names the days it will replace",
      "pass --date=YYYY-MM-DD, or both --start and --end",
    );
  if (start && end && end < start)
    throw usage(
      `--end (${end}) is before --start (${start})`,
      "the window is inclusive of both ends",
      "swap them",
    );

  return withApiSession(
    ctx,
    async (s) => {
      const device = await resolveDevice(s, ctx.args[0]);
      if (!device.id)
        throw usage(
          `device ${ctx.args[0]} has no dv_ id on this origin`,
          "recompute addresses a device by its TypeID",
          "run `liveone device list` to see the ids this origin serves",
        );

      const { body } = await apiFetch<WireRecompute>(
        s.origin,
        `/api/v4/devices/${device.id}/recompute`,
        {
          method: "POST",
          token: s.token,
          body: {
            ...(date ? { date } : { start, end }),
            dryRun: ctx.dryRun,
          },
          errors: {
            422: {
              exit: EXIT.USAGE,
              what: "the server refused the window",
              why: (b) => String(b.error ?? "refused"),
              next: "nothing was rebuilt",
            },
          },
        },
      );

      ctx.emit(body, () => renderRecompute(body));
      // A day that did not rebuild is a finding: the command ran, and is reporting what it found.
      return !body.dryRun && body.agg1dDays < body.days.length
        ? EXIT.FINDINGS
        : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/** What `POST /api/v4/devices/{id}/change-offset` answers. */
export interface WireChangeOffset {
  device: { id: string; systemId: number; name: string; vendor: string };
  offset: { from: number; to: number };
  /**
   * The device's area — REPORTED, never written. This verb moves `devices.day_offset_min` alone;
   * `divergesAfter` says whether that leaves the device bucketing on a different boundary from the
   * site it sits in (legal — the two offsets key different tables — but worth saying out loud).
   */
  area: {
    id: string;
    name: string;
    dayOffsetMin: number;
    otherDevices: string[];
    divergesAfter: boolean;
  } | null;
  span: { startDay: string; endDay: string; rows: number } | null;
  days: number;
  points: number;
  dryRun: boolean;
  deleted1d: number;
  agg1dDays: number;
  provenanceAreas: number;
  nextDay: string | null;
}

/**
 * Combine a re-bucket's passes into one report.
 *
 * 🛑 Three fields must come from the FIRST pass, not the last, and getting this wrong is precisely
 * the failure this verb exists to prevent. The delete happens once, on pass 1. A resumed pass
 * re-plans AFTER the offset has already been written, so its `offset.from` equals `offset.to` and its
 * `span.rows` counts only what pass 1 left behind. Taking the last body wholesale reported
 * `deleted1d: 0` and `600 → 600` on the real prod run — a re-bucket that moved a year of history
 * describing itself as a no-op.
 *
 * Only `agg1dDays` accumulates. `nextDay` and `dryRun` are genuinely the last pass's.
 */
export function mergeChangeOffsetPasses(
  first: WireChangeOffset,
  last: WireChangeOffset,
  agg1dDays: number,
): WireChangeOffset {
  return {
    ...last,
    agg1dDays,
    offset: first.offset,
    span: first.span,
    deleted1d: first.deleted1d,
  };
}

const signed = (m: number) => `${m >= 0 ? "+" : ""}${m}m`;

export function renderChangeOffset(r: WireChangeOffset, passes = 1): string {
  const out = [
    `device       ${r.device.systemId}  ${r.device.name}  (${r.device.vendor})`,
    `offset       ${signed(r.offset.from)} → ${signed(r.offset.to)}`,
    `area         ${
      r.area
        ? `${r.area.name}  buckets on ${signed(r.area.dayOffsetMin)}${
            r.area.divergesAfter
              ? "  ⚠️ NOT moved by this command"
              : " (unchanged, already equal)"
          }`
        : "(none — ambient device)"
    }`,
    `history      ${
      r.span
        ? `${r.span.startDay} → ${r.span.endDay}   ${r.span.rows} agg_1d row(s), ${r.days} day(s), ${r.points} point(s)`
        : `no agg_1d rows — offset moves, nothing to rebuild`
    }`,
  ];

  // 🛑 The one thing this command deliberately does NOT do, said before it is done rather than after.
  // `devices.day_offset_min` keys `point_readings_agg_1d`; `areas.day_offset_min` keys the area's
  // flow matrix and provenance. They are allowed to differ — but only on purpose.
  if (r.area?.divergesAfter) {
    out.push(
      "",
      `⚠️  The area "${r.area.name}" keeps bucketing on ${signed(r.area.dayOffsetMin)}, so its flow`,
      `    matrix and battery provenance will use a different day boundary from this device's`,
      `    daily totals.${
        r.area.otherDevices.length > 0
          ? ` ${r.area.otherDevices.length} other device(s) share it: ${r.area.otherDevices.join(", ")}.`
          : " This device is its only tenant."
      }`,
      `    If the AREA should move too, that is a separate, deliberate call:`,
      `      PATCH /api/v4/areas/{ar_} { "dayOffsetMin": ${r.offset.to} }`,
    );
  }

  if (r.dryRun) {
    out.push(
      "",
      "would rewrite the offset, DELETE those agg_1d rows and rebuild them on the new",
      "boundary, then refresh the flow matrix of every Area this device binds into.",
      "Daily totals will change. Nothing has been changed.",
      "(dry run — pass --apply to write)",
    );
    return out.join("\n");
  }

  out.push(
    "",
    `deleted      ${r.deleted1d} agg_1d row(s)`,
    `rebuilt      ${r.agg1dDays} of ${r.days} day(s)${passes > 1 ? `, over ${passes} passes` : ""}`,
    `flow         ${r.provenanceAreas} area(s) refreshed`,
  );
  // 🛑 The counts are a MEASUREMENT, not the request echoed back: the per-day rebuild is best-effort,
  // so a shortfall here has survived the resumption loop and is a genuine failure, not a budget stop.
  if (r.agg1dDays < r.days)
    out.push(
      "",
      `${r.days - r.agg1dDays} day(s) did NOT rebuild — the reason is in the server logs.`,
      "The offset IS changed, so those days are now absent rather than wrong. Finish them with:",
      `  liveone device recompute ${r.device.systemId} --start=… --end=… --apply`,
    );
  out.push(
    "",
    "Run detectors are NOT covered here — rebuild those with `liveone derivation recompute`.",
  );
  return out.join("\n");
}

async function runChangeOffset(ctx: Ctx): Promise<number> {
  const raw = str(ctx, "offset");
  if (raw === undefined)
    throw usage(
      "no --offset",
      "a re-bucket always names the boundary it is moving to",
      "pass --offset=600 (minutes east of UTC; 600 is AEST)",
    );
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset % 15 !== 0 || Math.abs(offset) > 840)
    throw usage(
      `--offset=${raw} is not a usable offset`,
      "it is minutes east of UTC: a whole number, a multiple of 15, within ±840",
      "pass --offset=600 for AEST, --offset=570 for ACST",
    );

  return withApiSession(
    ctx,
    async (s) => {
      const device = await resolveDevice(s, ctx.args[0]);
      if (!device.id)
        throw usage(
          `device ${ctx.args[0]} has no dv_ id on this origin`,
          "change-offset addresses a device by its TypeID",
          "run `liveone device list` to see the ids this origin serves",
        );

      const call = (resumeFrom: string | null) =>
        apiFetch<WireChangeOffset>(
          s.origin,
          `/api/v4/devices/${device.id}/change-offset`,
          {
            method: "POST",
            token: s.token,
            body: {
              dayOffsetMin: offset,
              dryRun: ctx.dryRun,
              ...(resumeFrom ? { resumeFrom } : {}),
            },
            errors: {
              422: {
                exit: EXIT.USAGE,
                what: "the server refused the change",
                why: (b) => String(b.error ?? "refused"),
                next: resumeFrom
                  ? `the offset IS changed; finish with --offset=${offset} again`
                  : "nothing was changed",
              },
            },
          },
        );

      // 🛑 The server rebuilds only what fits its own budget and reports where it stopped, because a
      // whole history does not fit in one serverless invocation (a measured 357-day device took
      // 6m29s against a 300 s ceiling). Driving the resumption from HERE is what keeps the operation
      // one command: the CLI is long-lived, the function is not.
      const first = await call(null).then((r) => r.body);
      let body = first;
      let agg1dDays = body.agg1dDays;
      let passes = 1;
      while (!body.dryRun && body.nextDay) {
        ctx.note(
          `rebuilt ${agg1dDays}/${body.days} day(s) — resuming from ${body.nextDay}`,
        );
        body = await call(body.nextDay).then((r) => r.body);
        agg1dDays += body.agg1dDays;
        passes++;
      }

      const merged = mergeChangeOffsetPasses(first, body, agg1dDays);
      ctx.emit(merged, () => renderChangeOffset(merged, passes));
      return !merged.dryRun && merged.agg1dDays < merged.days
        ? EXIT.FINDINGS
        : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/**
 * `device area <device> [<area>|--none]` — the device-side half of membership.
 *
 * 🛑 Everything this verb has to SAY is about the end the operator did not name. Membership is
 * `devices.area_id`, so a move has two halves: the destination gains the device's points, and the
 * source loses them along with every binding onto them. The dry run states both, because the
 * argument list only shows one.
 */
async function runDeviceArea(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const device = await resolveDevice(s, ctx.args[0]);
      const toNone = ctx.flags.none === true;
      const areaRef = ctx.args[1];
      if (toNone && areaRef !== undefined)
        throw usage(
          "both an area and --none were given",
          "a device goes to one area or to none — they are not combinable",
          "drop --none, or drop the area argument",
        );
      if (!toNone && areaRef === undefined)
        throw usage(
          "no destination given",
          "this verb states where the device goes",
          "name an area, or pass --none to leave it ambient",
        );

      const target = toNone ? null : await resolveArea(s, areaRef);
      // A no-op is worth saying out loud rather than writing: re-stating a device's current area
      // touches nothing server-side, and an operator who typed it meant something else.
      const already = toNone
        ? device.areaId === null
        : device.areaId === target!.id;

      const lines = [
        `device: ${device.name} (${device.id})`,
        `  from: ${device.areaName ?? "(ambient — no area)"}`,
        `    to: ${target ? target.displayName : "(ambient — no area)"}`,
      ];
      if (already) lines.push("", "(already there — nothing to do)");
      else if (device.areaId)
        lines.push(
          "",
          `🛑 "${device.areaName}" loses this device's points, and every binding onto them.`,
        );

      let result: unknown = null;
      if (!ctx.dryRun && !already)
        result = (
          await apiFetch<{
            areaId: string | null;
            previousAreaId: string | null;
            moved: boolean;
          }>(s.origin, `/api/v4/devices/${encodeURIComponent(device.id!)}`, {
            method: "PATCH",
            token: s.token,
            body: { areaId: target ? target.id : null },
            errors: {
              422: {
                exit: EXIT.FINDINGS,
                what: "the server refused the move",
                why: (b) => String(b.error ?? "refused"),
                next: "nothing was changed — an ambient device (an OpenElectricity region) cannot be placed",
              },
              403: {
                exit: EXIT.FINDINGS,
                what: "not yours to move",
                why: (b) => String(b.error ?? "forbidden"),
                next: "you must own the device or the area it is leaving, AND own the destination",
              },
            },
          })
        ).body;

      ctx.emit(
        {
          device: { id: device.id, name: device.name },
          from: { id: device.areaId, name: device.areaName },
          to: target ? { id: target.id, name: target.displayName } : null,
          alreadyThere: already,
          applied: !ctx.dryRun && !already,
          result,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} move`,
            ...lines,
            "",
            already
              ? "nothing to do."
              : ctx.dryRun
                ? "Re-run with --apply to write."
                : "written.",
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  area: runDeviceArea,
  show: runShow,
  points: runPoints,
  latest: runLatest,
  history: runHistory,
  recompute: runRecompute,
  "change-offset": runChangeOffset,
};

/**
 * Run whichever `device` verb was selected.
 *
 * 🛑 Keyed on the FULL path under `device`, not its last element. `device show` and
 * `device config show` share a last element, and dispatching on it would silently route the second
 * to the first — returning the device aggregate, looking like it worked, and never touching the
 * config. That is not hypothetical: it is the same collision `runArea` carries its own 🛑 about
 * (`area devices set` vs `area role set`), and this dispatcher was written the unsafe way before
 * `config` existed to collide with it.
 */
export async function runDevice(ctx: Ctx): Promise<number> {
  const path = ctx.subcommandPath.slice(1); // drop "device"
  const key = path.join(".");
  const handler = CONFIG_HANDLERS[key] ?? HANDLERS[key];
  if (!handler)
    throw usage(
      `unknown device command "${path.join(" ")}"`,
      "this verb has no handler",
      "run `npm run liveone -- device --help`",
    );
  return handler(ctx);
}
