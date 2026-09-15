/**
 * `liveone device archive` and `liveone device delete` — the two ways a device stops being one.
 *
 * ## The area verbs' twin, with one difference that matters
 *
 * `archive` is reversible and cheap: the row, its points and every reading stay, and the device
 * simply stops being active. `--undo` puts it back.
 *
 * `delete` destroys the row AND everything the device owns — its points, their raw readings and
 * both aggregate rollups, and its poll sessions. That is the difference from `area delete`, and it
 * is forced by the schema rather than chosen: `points.device_id` is NOT NULL, so a point cannot
 * outlive its device and "keep the history, drop the device" is not a state that exists. Refusing
 * over owned history would make the verb unusable on every device that ever recorded anything.
 *
 * What it DOES refuse over is everything that references the device from outside and would survive
 * it — a derivation reading or writing its points, an area binding selecting one, a managed poller,
 * a point command. Each is named with the column it lives in and the verb that clears it.
 *
 * 🛑 There is no `--force`, deliberately. The refusal IS the confirmation, and clearing what it
 * names is the confirmation step — the same argument `area delete` makes. What stands in for a
 * force here is the dry run: it prints the SPAN of what would be destroyed (first reading to last),
 * so the size of the decision is visible before `--apply`.
 */
import { EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch, type ErrorOverride } from "@/lib/cli-kit/http";
import {
  BASE_URL_FLAG,
  bool,
  dependentLines,
  resolveDevice,
  usage,
  type WireDevice,
} from "../../shared";

const DEVICE_ARG = {
  name: "device",
  required: true,
  variadic: true,
  help: "One or more devices: dv_… id, integer handle, slug or name",
} as const;

export const DEVICE_ARCHIVE_SPEC = {
  name: "archive",
  summary:
    "Retire a device: keep every row and reading, stop treating it as active.",
  when:
    "Use this when a device should stop being polled, listed and served, but its history must stay\n" +
    "readable. It is also the required first step before `device delete`.",
  description:
    "REVERSIBLE. The row, its points and every reading survive untouched. `--undo` puts it back.\n" +
    "\n" +
    "Archiving is still gated: an area or dashboard that names the device would go quiet with no\n" +
    "error anywhere, so anything that would stop working is named first.",
  mutates: true,
  args: [DEVICE_ARG],
  flags: {
    ...BASE_URL_FLAG,
    undo: {
      type: "boolean",
      help: "Un-archive instead: set the device back to active",
    },
  },
  exitCodes: { 1: "the server refused (the reason names what would go quiet)" },
  examples: [
    "liveone device archive 16",
    "liveone device archive 16 --apply",
    "liveone device archive 16 --undo --apply",
  ],
} as const satisfies CommandSpec;

export const DEVICE_DELETE_SPEC = {
  name: "delete",
  summary:
    "Destroy an archived device, its points and its history. Irreversible.",
  when:
    "Use this to finally remove a device you have already archived and cleared. If you only want it\n" +
    "to stop being polled and served, `device archive` is the whole operation.",
  description:
    "🛑 IRREVERSIBLE, and there is deliberately NO --force.\n" +
    "\n" +
    "This DESTROYS what the device owns — its points, their raw readings and both aggregate\n" +
    "rollups, and its poll sessions. Unlike `area delete`, that is not a refusal: a point cannot\n" +
    "exist without its device, so keeping the history is not an option the schema offers. The dry\n" +
    "run prints the SPAN of what would go, so the size of the decision is visible first.\n" +
    "\n" +
    "Two interlocks, neither waivable:\n" +
    "  1. the device must already be ARCHIVED (`liveone device archive <device> --apply`);\n" +
    "  2. nothing may still REFERENCE it — a derivation reading or writing its points, an area\n" +
    "     binding selecting one, a managed poller, a point command. The refusal names each, the\n" +
    "     column it lives in, and the verb that clears it.\n" +
    "\n" +
    "The device's integer handle SURVIVES: `legacy_handles.device_id` is nulled, not deleted, so a\n" +
    "handle shared with an area keeps resolving through that area.",
  mutates: true,
  args: [DEVICE_ARG],
  flags: { ...BASE_URL_FLAG },
  exitCodes: { 1: "the server refused (the reason names every dependent)" },
  examples: ["liveone device delete 16", "liveone device delete 16 --apply"],
} as const satisfies CommandSpec;

/**
 * 🛑 No "absent means everything" — the same guard `area delete` carries, and load-bearing for the
 * same reason: `required: true` on a VARIADIC arg is not enforced by `parse()`, so a bare
 * `liveone device delete` reaches the handler. Exported so the fact has its own test.
 */
export function deviceSubjects(ctx: Ctx): string[] {
  const refs = ctx.args.filter(Boolean);
  if (refs.length === 0)
    throw usage(
      "no device named",
      "this verb needs a subject, and there is deliberately no 'absent means everything'",
      "name one or more devices, e.g. `liveone device delete 16`",
    );
  return refs;
}

interface WireDependent {
  kind: string;
  id: string;
  name: string | null;
  via: string;
  effect: string;
  fix: string;
}

interface WireExtent {
  points: number;
  readings: { minMs: number; maxMs: number } | null;
}

async function previewDependents(
  s: ApiSession,
  deviceId: string,
  destructive: boolean,
): Promise<{ dependents: WireDependent[]; extent: WireExtent | null }> {
  const body = await s.get<{
    dependents: WireDependent[];
    extent?: WireExtent | null;
  }>(
    `/api/v4/devices/${encodeURIComponent(deviceId)}/dependents${destructive ? "?destructive=true" : ""}`,
  );
  return { dependents: body.dependents, extent: body.extent ?? null };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What a successful delete would destroy — the half no refusal ever mentions. */
const extentLine = (e: WireExtent | null) =>
  e === null
    ? null
    : e.readings === null
      ? `    would destroy ${e.points} point(s) — no readings`
      : `    would destroy ${e.points} point(s) and every reading from ${day(e.readings.minMs)} to ${day(e.readings.maxMs)}`;

const dependentLine = (d: WireDependent) =>
  `    ${d.kind}${d.name ? ` ${d.name}` : ""} (${d.id}) — via ${d.via}, ${d.effect}\n      → ${d.fix}`;

const REFUSAL_ERRORS: Record<number, ErrorOverride> = {
  409: {
    exit: EXIT.FINDINGS,
    what: "the server refused",
    why: (b: Record<string, unknown>) => {
      const detail = b.detail as Record<string, unknown> | undefined;
      const deps = dependentLines(b);
      return [
        String(b.error ?? "conflict"),
        ...(deps ?? []),
        ...(detail?.fix ? [String(detail.fix)] : []),
      ].join("\n");
    },
    next: "nothing was changed — clear what it named, then repeat",
  },
};

async function runDeviceArchive(ctx: Ctx): Promise<number> {
  const refs = deviceSubjects(ctx);
  const undo = bool(ctx, "undo") === true;
  const status = undo ? "active" : "archived";

  return withApiSession(
    ctx,
    async (s) => {
      // 🛑 `includeInactive`, ALWAYS. `resolveDevice` matches the ref against the LIST and its own
      // docstring is explicit that an omitted device is unaddressable "including by its literal
      // `dv_` id" — so without this, `--undo` could never resolve the archived device it exists to
      // restore. A lifecycle verb that cannot name a retired device is the one case it is for.
      const targets: WireDevice[] = [];
      for (const ref of refs)
        targets.push(await resolveDevice(s, ref, { includeInactive: true }));

      // Only asked when archiving: an UNDO removes no reference and cannot be refused for one.
      const blockers = new Map<string, WireDependent[]>();
      if (!undo)
        for (const d of targets) {
          const { dependents } = await previewDependents(s, d.id!, false);
          if (dependents.length > 0) blockers.set(d.id!, dependents);
        }

      // 🛑 Blocked means blocked. The server refuses this now (`refuseIfReliedUpon` on the status
      // PATCH), so applying anyway would spend a request to be told what the preview already said.
      const done: Record<string, unknown>[] = [];
      if (!ctx.dryRun && blockers.size === 0)
        for (const d of targets) {
          const res = await apiFetch<Record<string, unknown>>(
            s.origin,
            `/api/v4/devices/${d.id}`,
            {
              method: "PATCH",
              token: s.token,
              body: { status },
              errors: REFUSAL_ERRORS,
            },
          );
          done.push({ id: d.id, name: d.name, ...res.body });
        }

      ctx.emit(
        {
          status,
          applied: !ctx.dryRun,
          devices: targets,
          done,
          blockers: Object.fromEntries(blockers),
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} set status=${status} on ${targets.length} device(s) at ${s.origin}`,
            ...targets.flatMap((d) => [
              `  ${d.name} (${d.id}) handle=${d.legacySystemId ?? "-"}`,
              ...(blockers.get(d.id!) ?? []).map(dependentLine),
            ]),
            undo
              ? "  the device is active again and is polled and served"
              : "  every row and reading survives — the device simply stops being active",
            "",
            blockers.size > 0
              ? "🛑 the server WILL REFUSE this — resolve what is listed above first"
              : "",
            ctx.dryRun
              ? "Re-run with --apply to write."
              : `done. ${undo ? "" : "To destroy the row and its history as well: `liveone device delete <device>`"}`,
          ]
            .filter(Boolean)
            .join("\n"),
      );
      return blockers.size > 0 ? EXIT.FINDINGS : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function runDeviceDelete(ctx: Ctx): Promise<number> {
  const refs = deviceSubjects(ctx);

  return withApiSession(
    ctx,
    async (s) => {
      // 🛑 `includeInactive`, ALWAYS — and here it is load-bearing rather than convenient: this verb
      // ONLY accepts an archived device, and `resolveDevice` cannot see one without it. Without this
      // flag the command could never resolve a single valid subject.
      const targets: WireDevice[] = [];
      for (const ref of refs)
        targets.push(await resolveDevice(s, ref, { includeInactive: true }));

      // 🛑 Restated client-side so the dry run never describes something --apply would refuse.
      const active = targets.filter((d) => d.status && d.status !== "archived");
      if (active.length > 0)
        throw usage(
          `${active.map((d) => `${d.name} (${d.id})`).join(", ")} ${active.length === 1 ? "is" : "are"} not archived`,
          "delete is not the archive verb, and --apply would refuse: archiving first is one reversible command that lets you see what stops being served before anything is destroyed",
          `run \`liveone device archive ${active.map((d) => d.id).join(" ")} --apply\` first`,
        );

      const blockers = new Map<string, WireDependent[]>();
      const extents = new Map<string, WireExtent | null>();
      for (const d of targets) {
        const { dependents, extent } = await previewDependents(s, d.id!, true);
        if (dependents.length > 0) blockers.set(d.id!, dependents);
        extents.set(d.id!, extent);
      }

      const deleted: Record<string, unknown>[] = [];
      if (!ctx.dryRun && blockers.size === 0)
        for (const d of targets) {
          const res = await apiFetch<{ deleted: Record<string, unknown> }>(
            s.origin,
            `/api/v4/devices/${d.id}`,
            { method: "DELETE", token: s.token, errors: REFUSAL_ERRORS },
          );
          deleted.push(res.body.deleted);
        }

      ctx.emit(
        {
          applied: !ctx.dryRun,
          devices: targets,
          deleted,
          extents: Object.fromEntries(extents),
          blockers: Object.fromEntries(blockers),
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} DELETE ${targets.length} device(s) at ${s.origin}`,
            ...targets.flatMap((d) =>
              [
                `  ${d.name} (${d.id}) handle=${d.legacySystemId ?? "-"}`,
                extentLine(extents.get(d.id!) ?? null),
                ...(blockers.get(d.id!) ?? []).map(dependentLine),
              ].filter((l): l is string => l !== null),
            ),
            "  🛑 the row, its points, their readings and its archives are destroyed —",
            "  there is no undo and no --force",
            "  the integer handle survives: legacy_handles.device_id is nulled, not deleted",
            ...deleted.map((d) => {
              const x = d.destroyed as Record<string, number> | undefined;
              return x
                ? `  destroyed: ${x.points} point(s), ${x.rawReadings} raw, ${x.agg5m} agg_5m, ${x.agg1d} agg_1d, ${x.sessions} session(s)`
                : "";
            }),
            "",
            blockers.size > 0
              ? "🛑 the server WILL REFUSE this — clear what is listed above first. There is no --force."
              : "",
            ctx.dryRun
              ? blockers.size > 0
                ? "Nothing to re-run yet."
                : "Re-run with --apply to delete."
              : `deleted ${deleted.length} device(s).`,
          ]
            .filter(Boolean)
            .join("\n"),
      );
      return blockers.size > 0 ? EXIT.FINDINGS : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

export const DEVICE_RETIRE_HANDLERS: Record<
  string,
  (ctx: Ctx) => Promise<number>
> = {
  archive: runDeviceArchive,
  delete: runDeviceDelete,
};
