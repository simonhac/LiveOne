/**
 * The `device` domain of the `liveone` CLI — the physical/vendor layer: what a device is, what it
 * reports, and what it reported over time.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * Http-only, read-only: every verb calls the deployed API as you, against the same readable set
 * the web app serves.
 */
import { defineCommand, EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import {
  BASE_URL_FLAG,
  HISTORY_FLAGS,
  resolveRef,
  runHistoryVerb,
  str,
  usage,
} from "../shared";

const DEVICE_ARG = {
  name: "device",
  required: true,
  help: "A device: its dv_… id, integer handle, slug, or name",
} as const;

interface WireDevice {
  id: string | null;
  legacySystemId: number;
  name: string;
  slug: string | null;
  vendor: string;
  vendorSiteId: string | null;
  status: string;
  ownerUserId: string | null;
}

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

async function listDevices(s: ApiSession): Promise<WireDevice[]> {
  const { devices } = await s.get<{ devices: WireDevice[] }>("/api/v4/devices");
  return devices;
}

async function resolveDevice(s: ApiSession, ref: string): Promise<WireDevice> {
  return resolveRef(await listDevices(s), ref, {
    noun: "device",
    listCmd: "liveone device list",
  });
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
    "Read-only, and http-only: every verb calls the deployed API as you (`liveone auth login`),\n" +
    "and prints `target: <origin> as <you>` on stderr first — read it to know which environment\n" +
    "answered. Ids are per-environment.",
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
        "history.{firstInterval,lastInterval,interval,numIntervals,data}.",
      args: [DEVICE_ARG],
      flags: { ...BASE_URL_FLAG, ...HISTORY_FLAGS },
      exitCodes: { 1: "the window returned no series" },
      examples: [
        "liveone device history daylesford --last=3h",
        "liveone device history daylesford --interval=1d --start=2026-07-01 --end=2026-07-31",
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

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  show: runShow,
  points: runPoints,
  latest: runLatest,
  history: runHistory,
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
