/**
 * The `automation` verbs.
 *
 * Every verb is http — there is no `--via=db` here, for the same reason `derivation` has none:
 * what makes an automation SAFE (the ownership firewall on the action point, the trigger/action
 * pairing, the unit check on the load point) is all server-side in `checkReferences`, and a direct
 * write would be a way to store a rule none of it had ever seen.
 */
import { EXIT, num, str, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { resolveArea, usage, type WireArea } from "../shared";
import { listDerivations, resolveDerivation } from "../derivation/model";
import {
  actionWords,
  automationLine,
  decisionLines,
  parseTime,
  parseWeekdays,
  resolveAutomation,
  resolvePointFlag,
  triggerWords,
  type WireAutomation,
} from "./model";

const CREATE_ERRORS = {
  422: {
    exit: EXIT.FINDINGS,
    what: "the server refused this automation",
    why: (b: Record<string, unknown>) => String(b.error ?? "refused"),
    next: "adjust the flags to match — nothing was written",
  },
} as const;

/** Every verb starts here: the area, then its automations. There is no GET-by-id route. */
async function listAutomations(
  s: ApiSession,
  area: WireArea,
): Promise<WireAutomation[]> {
  const { automations } = await s.get<{ automations: WireAutomation[] }>(
    `/api/v4/automations?area=${encodeURIComponent(area.id!)}`,
  );
  return automations;
}

/** Resolve `<area> <automation>` — the shape four of the six verbs take. */
async function resolveTarget(
  s: ApiSession,
  ctx: Ctx,
): Promise<{ area: WireArea; row: WireAutomation }> {
  const area = await resolveArea(s, ctx.args[0]);
  const row = resolveAutomation(
    await listAutomations(s, area),
    ctx.args[1],
    area,
  );
  return { area, row };
}

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const rows = await listAutomations(s, area);
    ctx.emit(
      { area: { id: area.id, name: area.displayName }, automations: rows },
      () =>
        rows.length === 0
          ? `${area.displayName} (${area.id}) has no automations.`
          : [
              `${rows.length} automation${rows.length === 1 ? "" : "s"} on ${area.displayName} (${area.id})`,
              ...rows.map(automationLine),
            ].join("\n"),
    );
    return rows.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

async function runShow(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const { area, row } = await resolveTarget(s, ctx);
    ctx.emit(
      { area: { id: area.id, name: area.displayName }, automation: row },
      () => {
        const t = row.trigger;
        const out = [
          `${row.name} (${row.id})`,
          `  area:         ${area.displayName} (${area.id})`,
          `  enabled:      ${row.enabled}`,
          `  mode:         ${row.mode}`,
          `  trigger:      ${triggerWords(t)}`,
        ];
        if (t?.kind === "exercise" && t.unless)
          out.push(
            `  unless:       it ran ≥ ${t.unless.minMinutes} min above ${t.unless.minLoadKw} kW in the last ${t.unless.withinDays} days`,
            `  load point:   ${t.unless.loadPointId}`,
            `  grace:        ${t.schedule?.graceMinutes} min`,
          );
        out.push(`  action:       ${actionWords(row.action)}`);
        if (row.lastTriggeredAt)
          out.push(`  last fired:   ${row.lastTriggeredAt}`);
        out.push(...decisionLines(row.armedContext).map((l) => `  ${l}`));
        return out.join("\n");
      },
    );
    return EXIT.OK;
  });
}

async function runCreateExercise(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      // Parsed BEFORE any network call: a typo in --time should not cost four round trips first.
      const weekdays = parseWeekdays(str(ctx, "weekdays")!);
      const time = parseTime(str(ctx, "time")!);
      const minutes = num(ctx, "minutes")!;
      // 🛑 Not a range check. On a run-request point 0 RELEASES the latch — it is a stop — so a
      // "0-minute exercise" would be a scheduled shutdown wearing the name of a scheduled run.
      if (minutes <= 0)
        throw usage(
          `--minutes=${minutes}`,
          "0 is a STOP on a run-request point, not a run of zero length",
          "pass the number of minutes the engine should run for, e.g. --minutes=30",
        );

      const area = await resolveArea(s, ctx.args[0]);
      // `?area=` NARROWS the fleet-wide collection to derivations touching one of this area's
      // member devices — the same set the retired area-scoped listing served, asked for in the
      // vocabulary that survives 0064. An automation is still area-scoped; a derivation is not.
      const detector = resolveDerivation(
        await listDerivations(s, { area: area.id! }),
        str(ctx, "derivation")!,
        area.displayName,
      );
      const loadPointId = await resolvePointFlag(
        s,
        area,
        str(ctx, "loadPoint")!,
        "load-point",
      );
      const actionPointId = await resolvePointFlag(
        s,
        area,
        str(ctx, "actionPoint")!,
        "action-point",
      );

      // Sparse by contract: an omitted knob inherits the server's default and keeps inheriting it
      // as those defaults evolve. Pinning a value you did not choose is worse than omitting it.
      const schedule: Record<string, unknown> = { weekdays, time };
      const graceMinutes = num(ctx, "graceMinutes");
      if (graceMinutes !== undefined) schedule.graceMinutes = graceMinutes;

      const unless: Record<string, unknown> = { loadPointId };
      for (const [flag, key] of [
        ["minMinutes", "minMinutes"],
        ["minLoadKw", "minLoadKw"],
        ["dipSeconds", "dipToleranceSeconds"],
        ["withinDays", "withinDays"],
      ] as const) {
        const v = num(ctx, flag);
        if (v !== undefined) unless[key] = v;
      }

      const body = {
        areaId: area.id,
        // Always standing: an exercise rule that fired once and disarmed would be a one-off run
        // with a schedule attached, which is not a thing anyone wants.
        mode: "standing",
        name: str(ctx, "name") ?? "Generator exercise",
        trigger: {
          kind: "exercise",
          source: { kind: "derivation", derivationId: detector.id },
          schedule,
          unless,
        },
        action: {
          kind: "point-action",
          pointId: actionPointId,
          action: "set_value",
          value: minutes,
        },
      };

      let created: WireAutomation | undefined;
      if (!ctx.dryRun) {
        const { body: res } = await apiFetch<{ automation: WireAutomation }>(
          s.origin,
          "/api/v4/automations",
          { method: "POST", body, token: s.token, errors: CREATE_ERRORS },
        );
        created = res.automation;
      }

      ctx.emit(
        {
          area: { id: area.id, name: area.displayName },
          request: body,
          applied: !ctx.dryRun,
          automation: created ?? null,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} create an exercise rule on ${area.displayName} (${area.id})`,
            `  run:          ${minutes} min, ${weekdays.join(",")} at ${time} local`,
            `  detector:     ${detector.name} (${detector.id})`,
            `  load point:   ${loadPointId}`,
            `  action point: ${actionPointId}`,
            "  🛑 this STARTS THE ENGINE, unattended, on that schedule",
            created
              ? `created: ${created.id}`
              : "Re-run with --apply to create it.",
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/** `enable` and `disable` are one PATCH with one flipped boolean. */
function runSetEnabled(enabled: boolean): (ctx: Ctx) => Promise<number> {
  return (ctx) =>
    withApiSession(
      ctx,
      async (s) => {
        const { area, row } = await resolveTarget(s, ctx);
        if (row.enabled === enabled) {
          ctx.emit(
            { automation: row, applied: false, changed: false },
            () =>
              `${row.name} (${row.id}) is already ${enabled ? "enabled" : "disabled"} — nothing to do.`,
          );
          return EXIT.OK;
        }

        let updated: WireAutomation | undefined;
        if (!ctx.dryRun) {
          const { body } = await apiFetch<{ automation: WireAutomation }>(
            s.origin,
            `/api/v4/automations/${encodeURIComponent(row.id)}`,
            { method: "PATCH", body: { enabled }, token: s.token },
          );
          updated = body.automation;
        }

        ctx.emit(
          {
            automation: updated ?? row,
            enabled,
            changed: true,
            applied: !ctx.dryRun,
          },
          () =>
            [
              `${ctx.dryRun ? "would" : "WRITE"} ${enabled ? "enable" : "disable"} ` +
                `${row.name} (${row.id}) on ${area.displayName}`,
              enabled
                ? "  the minutely cron will evaluate it again — but a slot it has ALREADY dealt with stays dealt with"
                : "  it stops being evaluated; nothing else about it changes",
              ctx.dryRun ? "Re-run with --apply to write." : "written.",
            ].join("\n"),
        );
        return EXIT.OK;
      },
      ctx.dryRun ? "dry-run" : "APPLY",
    );
}

async function runDelete(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const { area, row } = await resolveTarget(s, ctx);
      if (!ctx.dryRun)
        await apiFetch(
          s.origin,
          `/api/v4/automations/${encodeURIComponent(row.id)}`,
          { method: "DELETE", token: s.token },
        );

      ctx.emit({ automation: row, applied: !ctx.dryRun }, () =>
        [
          `${ctx.dryRun ? "would" : "WRITE"} delete ${row.name} (${row.id}) from ${area.displayName}`,
          `  ${triggerWords(row.trigger)} → ${actionWords(row.action)}`,
          ctx.dryRun
            ? "Re-run with --apply to delete it. `disable` is the reversible option."
            : "deleted.",
        ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

export const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  show: runShow,
  "create-exercise": runCreateExercise,
  enable: runSetEnabled(true),
  disable: runSetEnabled(false),
  delete: runDelete,
};

/** Run whichever `automation` verb was selected (the LAST path element under `liveone`). */
export async function runAutomation(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown automation command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- automation --help`",
    );
  return handler(ctx);
}
