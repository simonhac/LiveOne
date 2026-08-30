/**
 * The `area` domain of the `liveone` CLI — the semantic layer: areas, their members and bindings,
 * their latest values, their history, and the rolled-up energy-flow (Sankey) matrix.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * Http-only: every read goes through the deployed API as you, so the readable set, the logical-
 * system resolution and the flow-matrix double-count rule are all enforced server-side — a db
 * transport here would have to re-implement each of them to be equally right.
 */
import fs from "node:fs";
import {
  defineCommand,
  EXIT,
  failWith,
  V,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import {
  sumDailyFlowMatricesWithMetrics,
  type DailyFlowMatrices,
  type EnergyFlowMatrixWithMetrics,
} from "@/lib/energy-flow-matrix";
import {
  atMostOne,
  BASE_URL_FLAG,
  bool,
  HISTORY_FLAGS,
  HISTORY_400,
  resolveRef,
  runHistoryVerb,
  str,
  timeParams,
  toCsv,
  usage,
} from "../shared";

const AREA_ARG = {
  name: "area",
  required: true,
  help: "An area: its ar_… id, integer handle, or display name",
} as const;

interface WireArea {
  id: string | null;
  displayName: string;
  legacySystemId: number | null;
  chartCapable: boolean;
}

/** List + resolve, shared by every verb that takes `<area>`. */
async function resolveArea(s: ApiSession, ref: string): Promise<WireArea> {
  const { areas } = await s.get<{ areas: WireArea[] }>("/api/v4/areas");
  return resolveRef(
    areas.map((a) => ({ ...a, name: a.displayName })),
    ref,
    { noun: "area", listCmd: "liveone area list" },
  );
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export const areaCommand = defineCommand({
  name: "area",
  summary:
    "Inspect areas — membership, bindings, latest values, history, flows.",
  when:
    "Reach for this for the SEMANTIC layer: what an area is made of and what it measured. For the\n" +
    "physical/vendor layer use `device`; for what a dashboard shows use `dashboard`.",
  description:
    "Read-only, and http-only: every verb calls the deployed API as you (`liveone auth login`),\n" +
    "and prints `target: <origin> as <you>` on stderr first — read it to know which environment\n" +
    "answered. Ids are per-environment.",
  uses: ["api"],
  subcommands: {
    list: {
      name: "list",
      summary: "List the areas you can read: id, handle, name.",
      when: "Start here when you do not yet know an area's id.",
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone area list", "liveone area list --format json"],
    },
    show: {
      name: "show",
      summary:
        "An area's full aggregate: meta, members, bindings, capabilities.",
      when: "Use this to see how an area is put together — which devices, which role→point bindings.",
      description:
        "The aggregate is an OBJECT, so the human rendering is the pretty-printed JSON — a table\n" +
        "would only hide its shape.",
      args: [AREA_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: [
        "liveone area show daylesford",
        "liveone area show ar_01kx8km3a3fh5v2csryvhskzep",
      ],
    },
    latest: {
      name: "latest",
      summary: "The area's current values, from the serving cache.",
      when:
        "Use this for 'what is it doing NOW' — the same latest map every dashboard card reads.\n" +
        "For anything with a time axis use `history`.",
      args: [AREA_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone area latest daylesford"],
    },
    history: {
      name: "history",
      summary:
        "Time series for an area, in the OpenNEM shape /api/history serves.",
      when:
        "Use this to pull an area's measured series over a window. The human rendering is a\n" +
        "per-series summary; the full payload goes to --out (or --format json).",
      args: [AREA_ARG],
      flags: { ...BASE_URL_FLAG, ...HISTORY_FLAGS },
      exitCodes: { 1: "the window returned no series" },
      examples: [
        "liveone area history daylesford --last=3d --interval=30m",
        "liveone area history daylesford --interval=1d --start=2026-07-01 --end=2026-07-31 --out=july.json",
      ],
    },
    flows: {
      name: "flows",
      summary:
        "The rolled-up source×load energy-flow matrix (the Sankey) for a period.",
      when:
        "Use this to download WHERE an area's energy came from and went to over a period, with the\n" +
        "attributed cost/emissions/renewable legs — the multi-day rollup of the per-day Sankey.",
      description:
        "Reads the materialized per-day matrices (`flow_attr_1d` via /api/history) and folds them:\n" +
        "energy is a plain sum; each metric leg sums only the days where it is known, and carries a\n" +
        "known-kWh denominator so averages divide by known energy only. Windows are capped at 13\n" +
        "months (the 1d serving cap). The matrix is per-AREA — never sum a multi-device area with\n" +
        "its member devices.",
      args: [AREA_ARG],
      flags: {
        ...BASE_URL_FLAG,
        last: {
          type: "string",
          placeholder: "30d",
          help: "Relative window ending today (default: 30d)",
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
          help: "Window end, inclusive",
        },
        perDay: {
          type: "boolean",
          help: "Also carry the raw per-day matrices (CSV: one row per day×edge)",
        },
        csv: {
          type: "boolean",
          help: "Serialise as CSV, one row per source×load edge (to pipe raw CSV, add --format=human or --out)",
        },
        out: {
          type: "string",
          placeholder: "path",
          help: "Write the CSV/JSON to this file; stdout gets a summary",
        },
      },
      exitCodes: {
        1: "no attributed flow for the window (the reason says why)",
      },
      examples: [
        "liveone area flows daylesford --last=90d",
        "liveone area flows daylesford --start=2026-01-01 --end=2026-06-30 --csv --out=flows.csv",
      ],
    },
  },
} satisfies CommandSpec);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const { areas } = await s.get<{ areas: WireArea[] }>("/api/v4/areas");
    ctx.emit({ count: areas.length, areas }, () =>
      [
        ...areas.map(
          (a) =>
            `${a.id ?? "(no id)"}  handle=${String(a.legacySystemId ?? "-").padEnd(8)} ${a.displayName}`,
        ),
        "",
        `${areas.length} area(s).`,
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

async function runShow(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const body = await s.get<Record<string, unknown>>(
      `/api/v4/areas/${encodeURIComponent(area.id!)}`,
    );
    // Object-heavy payload: the pretty JSON IS the human rendering (a table would hide the shape).
    ctx.emit(body, () => JSON.stringify(body, null, 2));
    return EXIT.OK;
  });
}

async function runLatest(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const body = await s.get<Record<string, unknown>>(
      `/api/data?areaId=${encodeURIComponent(area.id!)}`,
    );
    ctx.emit(body, () =>
      [
        `${area.displayName} (${area.id}) — latest:`,
        JSON.stringify(body, null, 2),
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

async function runHistory(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    return runHistoryVerb(
      ctx,
      s,
      `areaId=${encodeURIComponent(area.id!)}`,
      `${area.displayName} (${area.id})`,
    );
  });
}

/** The metric legs, in one fixed column order shared by both CSV shapes. */
const METRIC_COLS = [
  "emissionsG",
  "renewableKwh",
  "selfRenewableKwh",
  "costC",
  "revenueC",
] as const;

function summedCsv(m: EnergyFlowMatrixWithMetrics): string {
  const header = [
    "source",
    "load",
    "energy_kwh",
    ...METRIC_COLS.flatMap((k) => [snake(k), `${snake(k)}_known_kwh`]),
    "estimated_kwh",
  ];
  const rows: (string | number | null)[][] = [];
  m.sources.forEach((src, i) =>
    m.loads.forEach((load, j) => {
      const energy = m.matrix[i][j];
      const metrics = METRIC_COLS.flatMap((k) =>
        m.metrics
          ? [m.metrics[k].matrix[i][j], m.metrics[k].knownKwh[i][j]]
          : [null, null],
      );
      const estimated = m.metrics?.estimatedKwh[i][j] ?? null;
      if (energy === 0 && metrics.every((v) => v === null || v === 0)) return;
      rows.push([src.id, load.id, energy, ...metrics, estimated]);
    }),
  );
  return toCsv(header, rows);
}

function perDayCsv(d: DailyFlowMatrices): string {
  const header = [
    "day",
    "source",
    "load",
    "energy_kwh",
    ...METRIC_COLS.map(snake),
    "estimated_kwh",
  ];
  const rows: (string | number | null)[][] = [];
  for (const day of d.days)
    d.sources.forEach((src, i) =>
      d.loads.forEach((load, j) => {
        const energy = day.matrix[i][j];
        const metrics = METRIC_COLS.map((k) => day[k]?.[i][j] ?? null);
        if (energy === 0 && metrics.every((v) => v === null || v === 0)) return;
        rows.push([
          day.day,
          src.id,
          load.id,
          energy,
          ...metrics,
          day.estimatedKwh?.[i][j] ?? null,
        ]);
      }),
    );
  return toCsv(header, rows);
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

async function runFlows(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const params = [
      `areaId=${encodeURIComponent(area.id!)}`,
      "interval=1d",
      "include=sankey",
      timeParams(ctx, "1d", "30d"),
    ].join("&");
    const body = await s.get<{
      requestStart?: string;
      requestEnd?: string;
      attributedFlow?: DailyFlowMatrices;
      attributedFlowOmittedReason?: string;
    }>(`/api/history?${params}`, { errors: HISTORY_400 });

    const flow = body.attributedFlow;
    const summed = flow ? sumDailyFlowMatricesWithMetrics(flow) : null;
    if (!flow || !summed)
      throw failWith(
        EXIT.FINDINGS,
        `no attributed flow for ${area.displayName} over ${body.requestStart ?? "?"} → ${body.requestEnd ?? "?"}`,
        `the server said: ${body.attributedFlowOmittedReason ?? "no days materialized"}`,
        "flows exist for logical systems with materialized provenance — try a different window, or run recompute-provenance",
      );

    const perDay = bool(ctx, "perDay");
    const wantCsv = bool(ctx, "csv");
    const out = str(ctx, "out");
    const csv = wantCsv ? (perDay ? perDayCsv(flow) : summedCsv(summed)) : null;

    const model: Record<string, unknown> = {
      area: { id: area.id, name: area.displayName },
      range: {
        start: body.requestStart,
        end: body.requestEnd,
        days: flow.days.length,
      },
      summed,
      ...(perDay && !wantCsv
        ? {
            perDay: {
              sources: flow.sources,
              loads: flow.loads,
              days: flow.days,
            },
          }
        : {}),
    };

    if (out !== undefined) {
      fs.writeFileSync(out, csv ?? JSON.stringify(model, null, 2) + "\n");
      ctx.emit(
        {
          ...model,
          summed: undefined,
          file: out,
          format: csv ? "csv" : "json",
        },
        () =>
          `wrote ${csv ? "CSV" : "JSON"} for ${area.displayName}, ${flow.days.length} day(s) ${body.requestStart} → ${body.requestEnd}, to ${out}`,
      );
      return EXIT.OK;
    }

    if (csv !== null) {
      // CSV is a third serialisation of the same model: raw under --format=human (the terminal
      // default), carried as a field under json so nothing is ever lost to the format flag.
      ctx.emit({ ...model, csv }, () => csv);
      return EXIT.OK;
    }

    ctx.emit(model, () => {
      const lines = [
        `${area.displayName} (${area.id})  ${body.requestStart} → ${body.requestEnd}  (${flow.days.length} day(s))`,
      ];
      summed.sources.forEach((src, i) =>
        summed.loads.forEach((load, j) => {
          const e = summed.matrix[i][j];
          if (e === 0) return;
          const cost = summed.metrics?.costC.matrix[i][j];
          const em = summed.metrics?.emissionsG.matrix[i][j];
          lines.push(
            `  ${src.id.padEnd(24)} → ${load.id.padEnd(22)} ${e.toFixed(1).padStart(9)} kWh` +
              (cost != null
                ? `  $${(cost / 100).toFixed(2).padStart(8)}`
                : "") +
              (em != null
                ? `  ${(em / 1000).toFixed(1).padStart(7)} kg CO₂`
                : ""),
          );
        }),
      );
      lines.push(`total ${summed.totalEnergy.toFixed(1)} kWh`);
      return lines.join("\n");
    });
    return EXIT.OK;
  });
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  show: runShow,
  latest: runLatest,
  history: runHistory,
  flows: runFlows,
};

/** Run whichever `area` verb was selected (the LAST path element under `liveone`). */
export async function runArea(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown area command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- area --help`",
    );
  return handler(ctx);
}
