/**
 * `liveone area provenance` / `liveone area purge` — read and RETIRE an Area's derived rows.
 *
 * ## Why a purge exists
 *
 * Every other verb in this CLI materialises. Nothing retires — which is fine while an area stays a
 * site, and wrong the moment one stops being one. Clear an area's bindings and it drops out of
 * flow-eligibility: nothing refreshes its derived rows, and nothing removes them either. They freeze
 * and keep answering. Area 13 ("Kutis") sat for weeks attributing 160.0 kg CO₂ to a house that High
 * Street Kew attributes 155.6 kg to, computed from a member set that no longer existed, with
 * `costC` 0 — and the only deletion paths in the codebase were a fleet-wide `agg_1d` sweep (wrong
 * table) and a per-day delete buried inside a recompute.
 *
 * ## Two verbs, because they are two risks
 *
 *   purge flows        the Sankey — `point_readings_flow_attr_1d`. 🛑 NOT cron-recoverable.
 *   purge provenance   the battery fold + its blend series. Self-healing; safe.
 *
 * The split is not cosmetic. `point_readings_flow_attr_1d` is the flow matrix wearing a provenance
 * table's name (`flow_1d` was retired into it), so it holds the ENERGY history of every complete
 * area, battery or not — and `rehealStaleAttrDays` finds its work by selecting from that very table,
 * so a deleted day is not a stale day it will rebuild, it is a day that has stopped existing. Only
 * an explicit recompute over the range restores it. `battery_provenance_daily` is the opposite: the
 * learn forces a full rebuild from a fixed anchor whenever its table is empty.
 *
 * So `purge flows` demands a window and prints the restore command; `purge provenance` needs neither.
 */
import { EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { BASE_URL_FLAG, resolveArea, str, usage } from "../../shared";

const AREA_ARG = {
  name: "area",
  required: true,
  help: "An area: its ar_… id, integer handle, or display name",
} as const;

const WINDOW_FLAGS = {
  start: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    help: "Window start (local days)",
  },
  end: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    help: "Window end, inclusive (local days)",
  },
} as const;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export const PROVENANCE_SPEC = {
  name: "provenance",
  summary:
    "What derived rows an area actually holds — the flow matrix and the battery fold.",
  when:
    "Use this before a `purge`, and to answer 'is this area still computing anything?' — an area\n" +
    "that has stopped being a site keeps its rows and keeps looking authoritative.",
  description:
    "Reports both layers: the flow matrix (rows, days, range — needs --start/--end) and the battery\n" +
    "provenance (fold rows, the helper device, its blend readings and bindings).\n" +
    "\n" +
    "Read-only. This is the evidence a `purge` dry run is based on.",
  args: [AREA_ARG],
  flags: { ...BASE_URL_FLAG, ...WINDOW_FLAGS },
  examples: [
    "liveone area provenance kutis",
    "liveone area provenance 13 --start=2026-07-06 --end=2026-09-12",
  ],
} satisfies CommandSpec;

export const PURGE_SPEC = {
  name: "purge",
  summary:
    "Delete an area's derived rows — the flow matrix, or the battery fold.",
  when:
    "Reach for this when an area has STOPPED being a site — its bindings were cleared, or it was\n" +
    "superseded by a larger area — and its derived rows are frozen rather than merely stale. To\n" +
    "REBUILD rows that are stale, use `device recompute` or the recompute-provenance endpoint; this\n" +
    "verb is for rows that should no longer exist at all.",
  description:
    "🛑 Read `area provenance <area>` first — it reports exactly what these verbs would remove.\n" +
    "\n" +
    "The two sub-verbs are NOT equally safe. `flows` deletes the Sankey and is not recoverable by\n" +
    "any cron; `provenance` deletes the battery fold, which the learn rebuilds from scratch. Both\n" +
    "are dry-run by default.",
  subcommands: {
    flows: {
      name: "flows",
      summary:
        "Delete the area's flow/Sankey matrix over a window of local days.",
      when:
        "Use this only for an area whose flow matrix should not exist — a retired area-of-one, or\n" +
        "one superseded by a larger area that now owns the interpretation.",
      description:
        "🛑 This is the SANKEY, not just 'provenance'. `point_readings_flow_attr_1d` holds the energy\n" +
        "history of every complete area (`flow_1d` was retired into it) with the attributed\n" +
        "emissions/renewable/cost/revenue legs over it. Deleting a row takes both.\n" +
        "\n" +
        "🛑 And NOTHING heals it. The nightly reheal reaches 96h back, and it finds work by reading\n" +
        "this table — so a deleted day is not stale, it is absent, and the backlog will never look\n" +
        "for it. Only an explicit recompute over the range restores it; the output names that\n" +
        "command.\n" +
        "\n" +
        "--start and --end are REQUIRED. There is no unscoped form: the fleet-wide twin\n" +
        "(`/api/cron/daily`) reads a missing date as ALL HISTORY, and a verb whose dangerous case is\n" +
        "the one you get by typing less will eventually be typed less.",
      mutates: true,
      args: [AREA_ARG],
      flags: { ...BASE_URL_FLAG, ...WINDOW_FLAGS },
      exitCodes: { 1: "there was nothing in that window to delete" },
      examples: [
        "liveone area purge flows 13 --start=2026-07-06 --end=2026-09-12",
        "liveone area purge flows 13 --start=2026-07-06 --end=2026-09-12 --apply",
      ],
    },
    provenance: {
      name: "provenance",
      summary:
        "Delete the area's battery provenance: the fold, its blend series and their bindings.",
      when:
        "Use this for an area that should no longer carry a battery blend at all. To merely REBUILD\n" +
        "a wrong blend, recompute instead — this removes the rows, it does not refresh them.",
      description:
        "Removes three things that are one fact in three homes: the six `bidi.battery/*` blend series\n" +
        "on the area's helper device (agg_5m + agg_1d), their `role=battery` bindings, and every\n" +
        "`battery_provenance_daily` row — learn inputs, learned parameters AND the fold checkpoints.\n" +
        "Then rebuilds the subscription registry so the frozen values leave the KV latest map, which\n" +
        "no delete does on its own.\n" +
        "\n" +
        "Safe, unlike its sibling: the learn forces a full rebuild from its fixed anchor whenever the\n" +
        "table is empty, so this is a supported operation rather than damage. No window needed.\n" +
        "\n" +
        "🛑 The helper DEVICE and its POINTS survive — they go inert and the next recompute refills\n" +
        "the same `pt_` ids.",
      mutates: true,
      args: [AREA_ARG],
      flags: { ...BASE_URL_FLAG },
      exitCodes: { 1: "the area had no battery provenance to delete" },
      examples: [
        "liveone area purge provenance 13",
        "liveone area purge provenance 13 --apply",
      ],
    },
  },
} satisfies CommandSpec;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface FlowsReport {
  rows: number;
  days: number;
  firstDay: string | null;
  lastDay: string | null;
}

interface ProvenanceReport {
  dailyRows: number;
  firstDay: string | null;
  lastDay: string | null;
  helper: { deviceId: string; name: string; pointRids: number[] } | null;
  agg5mRows: number;
  agg1dRows: number;
  bindings: number;
}

function requireWindow(ctx: Ctx): { start: string; end: string } {
  const start = str(ctx, "start");
  const end = str(ctx, "end");
  if (!start || !end)
    throw usage(
      "no window given",
      "`purge flows` deletes rows nothing will rebuild, so it has no unscoped form",
      "pass --start=YYYY-MM-DD --end=YYYY-MM-DD",
    );
  return { start, end };
}

function renderProvenance(p: ProvenanceReport): string[] {
  const lines = [
    `  battery fold      ${p.dailyRows} day row(s)` +
      (p.firstDay ? `  ${p.firstDay} → ${p.lastDay}` : ""),
  ];
  if (p.helper) {
    lines.push(`  helper device     ${p.helper.name} (${p.helper.deviceId})`);
    lines.push(
      `  blend series      ${p.helper.pointRids.length} point(s), ${p.agg5mRows} × 5m + ${p.agg1dRows} × 1d reading(s)`,
    );
  } else {
    lines.push("  helper device     (none — this area has no battery blend)");
  }
  lines.push(`  blend bindings    ${p.bindings}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function runProvenanceRead(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const start = str(ctx, "start");
    const end = str(ctx, "end");

    const prov = await s.get<ProvenanceReport & { ok: boolean }>(
      `/api/v4/areas/${area.id}/provenance`,
    );
    const flows =
      start && end
        ? await s.get<FlowsReport & { ok: boolean }>(
            `/api/v4/areas/${area.id}/flows?start=${start}&end=${end}`,
          )
        : null;

    ctx.emit(
      {
        area: { id: area.id, name: area.displayName },
        flows,
        provenance: prov,
      },
      () =>
        [
          `${area.displayName} (${area.id})`,
          flows
            ? `  flow matrix       ${flows.rows} row(s) over ${flows.days} day(s)` +
              (flows.firstDay ? `  ${flows.firstDay} → ${flows.lastDay}` : "")
            : "  flow matrix       (pass --start/--end to count it)",
          ...renderProvenance(prov),
        ].join("\n"),
    );
    return EXIT.OK;
  });
}

async function runPurgeFlows(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const area = await resolveArea(s, ctx.args[0]);
      const window = requireWindow(ctx);
      const at = `/api/v4/areas/${area.id}/flows?start=${window.start}&end=${window.end}`;

      // The dry run and the delete report the SAME numbers, because the route counts before it
      // deletes and returns that count — not a count taken afterwards, which would always be zero.
      const found = await s.get<FlowsReport & { ok: boolean }>(at);
      let deleted: FlowsReport | null = null;
      if (!ctx.dryRun && found.rows > 0) {
        const res = await apiFetch<{ deleted: FlowsReport }>(s.origin, at, {
          method: "DELETE",
          token: s.token,
        });
        deleted = res.body.deleted;
      }

      ctx.emit(
        {
          area: { id: area.id, name: area.displayName },
          range: window,
          found,
          applied: !ctx.dryRun,
          deleted,
        },
        () => {
          if (found.rows === 0)
            return `nothing to delete — ${area.displayName} has no flow matrix rows in ${window.start} → ${window.end}`;
          const lines = [
            `${ctx.dryRun ? "would" : "WRITE"} DELETE ${found.rows} flow-matrix row(s) from ${area.displayName} (${area.id})`,
            `  ${found.days} day(s), ${found.firstDay} → ${found.lastDay}`,
            "  🛑 this is the SANKEY — the energy history and its attribution, not just provenance",
            "  🛑 no cron rebuilds it: the backlog finds work by reading this table, so deleted days",
            "     are absent rather than stale and will never be looked for",
          ];
          lines.push(
            "",
            ctx.dryRun
              ? "Re-run with --apply to delete."
              : `deleted. Restore with:\n  liveone api "/api/v4/areas/${area.id}/recompute-provenance" --method=POST --body='{"start":"${window.start}","end":"${window.end}"}' --apply`,
          );
          return lines.join("\n");
        },
      );
      return found.rows === 0 ? EXIT.FINDINGS : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function runPurgeProvenance(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const area = await resolveArea(s, ctx.args[0]);
      const at = `/api/v4/areas/${area.id}/provenance`;

      const found = await s.get<ProvenanceReport & { ok: boolean }>(at);
      const nothing =
        found.dailyRows === 0 &&
        found.agg5mRows === 0 &&
        found.agg1dRows === 0 &&
        found.bindings === 0;

      let deleted: ProvenanceReport | null = null;
      if (!ctx.dryRun && !nothing) {
        const res = await apiFetch<{ deleted: ProvenanceReport }>(
          s.origin,
          at,
          {
            method: "DELETE",
            token: s.token,
          },
        );
        deleted = res.body.deleted;
      }

      ctx.emit(
        {
          area: { id: area.id, name: area.displayName },
          found,
          applied: !ctx.dryRun,
          deleted,
        },
        () => {
          if (nothing)
            return `nothing to delete — ${area.displayName} holds no battery provenance`;
          const lines = [
            `${ctx.dryRun ? "would" : "WRITE"} DELETE the battery provenance of ${area.displayName} (${area.id})`,
            ...renderProvenance(found),
            "  the helper device and its points SURVIVE — inert, and refilled by the next recompute",
          ];
          lines.push(
            "",
            ctx.dryRun
              ? "Re-run with --apply to delete."
              : `deleted. The learn rebuilds from its fixed anchor on the next run; to force it now:\n  liveone api "/api/v4/areas/${area.id}/recompute-provenance" --method=POST --apply`,
          );
          return lines.join("\n");
        },
      );
      return nothing ? EXIT.FINDINGS : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

export const PURGE_HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  provenance: runProvenanceRead,
  "purge.flows": runPurgeFlows,
  "purge.provenance": runPurgeProvenance,
};
