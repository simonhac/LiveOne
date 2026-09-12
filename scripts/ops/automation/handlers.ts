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
  buildRRule,
  decisionLines,
  parseDate,
  parseStart,
  resolveAutomation,
  resolvePointFlag,
  scheduleLines,
  triggerWords,
  type WireAutomation,
  type WireTrigger,
} from "./model";
import { occurrencesBetween } from "@/lib/automations/recurrence";
import type { ExerciseSchedule } from "@/lib/db/planetscale/schema";

const CREATE_ERRORS = {
  422: {
    exit: EXIT.FINDINGS,
    what: "the server refused this automation",
    why: (b: Record<string, unknown>) => String(b.error ?? "refused"),
    next: "adjust the flags to match — nothing was written",
  },
} as const;

/**
 * Every verb starts here: the area, then its automations. There is no GET-by-id route.
 *
 * The zone comes back WITH the rows because every schedule in them is a local wall clock in it and
 * is stored without it — rendering or expanding one without the zone is a guess.
 */
async function listAutomations(
  s: ApiSession,
  area: WireArea,
): Promise<{ rows: WireAutomation[]; timezone: string }> {
  const { automations, timezone } = await s.get<{
    automations: WireAutomation[];
    timezone: string;
  }>(`/api/v4/automations?area=${encodeURIComponent(area.id!)}`);
  return { rows: automations, timezone };
}

/** Resolve `<area> <automation>` — the shape five of the eight verbs take. */
async function resolveTarget(
  s: ApiSession,
  ctx: Ctx,
): Promise<{ area: WireArea; row: WireAutomation; timezone: string }> {
  const area = await resolveArea(s, ctx.args[0]);
  const { rows, timezone } = await listAutomations(s, area);
  return { area, row: resolveAutomation(rows, ctx.args[1], area), timezone };
}

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const { rows, timezone } = await listAutomations(s, area);
    ctx.emit(
      {
        area: { id: area.id, name: area.displayName },
        timezone,
        automations: rows,
      },
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
    const { area, row, timezone } = await resolveTarget(s, ctx);
    ctx.emit(
      {
        area: { id: area.id, name: area.displayName },
        timezone,
        automation: row,
      },
      () => {
        const t = row.trigger;
        const out = [
          `${row.name} (${row.id})`,
          `  area:         ${area.displayName} (${area.id})`,
          `  enabled:      ${row.enabled}`,
          `  mode:         ${row.mode}`,
          `  trigger:      ${triggerWords(t)}`,
        ];
        if (t?.kind === "exercise" && t.schedule)
          out.push(...scheduleLines(t.schedule, timezone, row.nextAt));
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
      // Parsed BEFORE any network call: a typo in --start should not cost four round trips first.
      const start = parseStart(str(ctx, "start")!);
      const untilFlag = str(ctx, "until");
      const rrule = buildRRule({
        rrule: str(ctx, "rrule"),
        until:
          untilFlag === undefined ? undefined : parseDate(untilFlag, "until"),
        count: num(ctx, "count"),
      });
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
      const schedule: Record<string, unknown> = { start };
      if (rrule !== undefined) schedule.rrule = rrule;
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
        // Always standing. A one-off is expressed in the SCHEDULE (a start with no rrule), which
        // is also the only place it can be said once and mean one thing — the server refuses
        // `mode: "once"` on an exercise trigger for exactly that reason.
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
            `  run:          ${minutes} min, from ${start} local`,
            `  repeats:      ${rrule ?? "no — this is a ONE-OFF, and disables itself once it has run"}`,
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

/** The exercise rules on an area, with their schedules — the input both new verbs share. */
function exerciseRules(
  rows: WireAutomation[],
): { row: WireAutomation; schedule: ExerciseSchedule }[] {
  const out: { row: WireAutomation; schedule: ExerciseSchedule }[] = [];
  for (const row of rows) {
    const t = row.trigger;
    if (t?.kind === "exercise" && t.schedule)
      out.push({ row, schedule: t.schedule });
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * What will ACTUALLY happen on this area, dated, for the next N days.
 *
 * Expanded client-side from the stored schedule and the area's zone rather than asked of the
 * server, because that is the same expander the evaluator uses — so a disagreement between this
 * listing and reality is a bug in one shared place, not a second implementation drifting from the
 * first.
 */
async function runUpcoming(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const { rows, timezone } = await listAutomations(s, area);
    const days = num(ctx, "days") ?? 30;
    const includeDisabled = ctx.flags.all === true;

    const fromMs = Date.now();
    const toMs = fromMs + days * DAY_MS;
    const events = exerciseRules(rows)
      .filter(({ row }) => includeDisabled || row.enabled)
      .flatMap(({ row, schedule }) =>
        occurrencesBetween(schedule, timezone, fromMs, toMs).map((slot) => ({
          atMs: slot.atMs,
          at: new Date(slot.atMs).toISOString(),
          automation: { id: row.id, name: row.name, enabled: row.enabled },
        })),
      )
      .sort((a, b) => a.atMs - b.atMs);

    const local = new Intl.DateTimeFormat("en-AU", {
      timeZone: timezone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    ctx.emit(
      {
        area: { id: area.id, name: area.displayName },
        timezone,
        days,
        occurrences: events,
      },
      () =>
        events.length === 0
          ? `Nothing scheduled on ${area.displayName} (${area.id}) in the next ${days} days.`
          : [
              `${events.length} occurrence${events.length === 1 ? "" : "s"} on ${area.displayName} ` +
                `in the next ${days} days (${timezone})`,
              ...events.map(
                (e) =>
                  `  ${local.format(new Date(e.atMs)).padEnd(22)} ${e.automation.name}` +
                  (e.automation.enabled ? "" : "  (DISABLED)"),
              ),
            ].join("\n"),
    );
    return events.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

/**
 * Drop ONE occurrence, by adding an EXDATE.
 *
 * The date must actually have an occurrence: "skip next Thursday" against a rule that does not run
 * next Thursday is a misunderstanding about which rule is which, and silently storing a no-op
 * exdate would hide it until the week the engine started anyway.
 */
async function runSkip(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const date = parseDate(str(ctx, "date")!, "date");
      const { area, row, timezone } = await resolveTarget(s, ctx);
      const trigger = row.trigger;
      if (trigger?.kind !== "exercise" || !trigger.schedule)
        throw usage(
          `${row.name} (${row.id}) is not an exercise rule`,
          "only a scheduled rule has occurrences to skip",
          `run \`liveone automation show ${area.id} ${row.id}\``,
        );
      const schedule = trigger.schedule;

      // Expanded over the LOCAL day, so "the 24th" means the 24th where the generator is.
      const dayStart = occurrencesBetween(
        schedule,
        timezone,
        Date.parse(`${date}T00:00:00Z`) - 2 * DAY_MS,
        Date.parse(`${date}T00:00:00Z`) + 2 * DAY_MS,
      ).filter((slot) => localDate(slot.atMs, timezone) === date);

      if (dayStart.length === 0) {
        ctx.emit(
          { automation: row, date, applied: false, changed: false },
          () =>
            [
              `${row.name} (${row.id}) has no occurrence on ${date} (${timezone}).`,
              "Nothing to skip — run `liveone automation upcoming` to see the real dates.",
            ].join("\n"),
        );
        return EXIT.FINDINGS;
      }

      const wallClocks = dayStart.map((slot) => wallClock(slot.atMs, timezone));
      const already = wallClocks.every((w) => schedule.exdates?.includes(w));
      const exdates = [
        ...new Set([...(schedule.exdates ?? []), ...wallClocks]),
      ].sort();

      // 🛑 A whole-object replace, because the route has no per-field schedule patch. `start` and
      // `rrule` go back BYTE-IDENTICAL, which is what keeps a slot already consumed today
      // consumed — the route only clears that key when the instants themselves move.
      const nextTrigger: WireTrigger = {
        ...trigger,
        schedule: { ...schedule, exdates },
      };

      let updated: WireAutomation | undefined;
      if (!already && !ctx.dryRun) {
        const { body } = await apiFetch<{ automation: WireAutomation }>(
          s.origin,
          `/api/v4/automations/${encodeURIComponent(row.id)}`,
          {
            method: "PATCH",
            body: { trigger: nextTrigger },
            token: s.token,
            errors: CREATE_ERRORS,
          },
        );
        updated = body.automation;
      }

      ctx.emit(
        {
          automation: updated ?? row,
          date,
          skipped: wallClocks,
          changed: !already,
          applied: !already && !ctx.dryRun,
        },
        () =>
          already
            ? `${row.name} (${row.id}) already skips ${wallClocks.join(", ")} — nothing to do.`
            : [
                `${ctx.dryRun ? "would" : "WRITE"} skip ${wallClocks.join(", ")} ` +
                  `on ${row.name} (${row.id})`,
                "  the rule itself is unchanged and keeps running afterwards",
                ctx.dryRun ? "Re-run with --apply to write." : "written.",
              ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/** An instant as `YYYY-MM-DD` in a zone — `Intl` because the offset is the zone's, not ours. */
function localDate(atMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(atMs));
}

/** An instant as the stored `"YYYY-MM-DDTHH:MM"` wall clock in a zone. */
function wallClock(atMs: number, timezone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(atMs));
  return `${localDate(atMs, timezone)}T${time}`;
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
  upcoming: runUpcoming,
  skip: runSkip,
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
