/**
 * The `device` domain of the `liveone` CLI — the physical/vendor layer: what a device is, what it
 * reports, and what it reported over time.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * Http-only: every verb calls the deployed API as you, against the same readable set the web app
 * serves.
 *
 * Read-only except for ONE verb, `recompute` — which rebuilds the rows computed FROM a device's
 * readings (`agg_1d`, the per-Area flow matrix) for a window that has changed underneath them. It
 * lives here rather than in a domain of its own because its subject is a device and its window is
 * whatever a repair touched; `liveone sync` publishes the readings and points at it by name.
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
  resolveDevice,
  runHistoryVerb,
  str,
  usage,
  type WireDevice,
} from "../shared";

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
    "Every verb here READS except `recompute`, which writes and is dry-run by default.",
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
  timezoneOffsetMin: number;
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
    }, offset ${r.timezoneOffsetMin >= 0 ? "+" : ""}${r.timezoneOffsetMin}m)`,
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

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  show: runShow,
  points: runPoints,
  latest: runLatest,
  history: runHistory,
  recompute: runRecompute,
};

/** Run whichever `device` verb was selected (the LAST path element under `liveone`). */
export async function runDevice(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown device command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- device --help`",
    );
  return handler(ctx);
}
