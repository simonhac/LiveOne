/**
 * `liveone area archive` and `liveone area delete` — the two ways an area stops being one.
 *
 * ## They are two verbs because they are two decisions
 *
 * `archive` is reversible and cheap: the row stays, every FK stays satisfied, and the area simply
 * stops being served. Nothing is lost, and un-archiving is `area archive --undo`.
 *
 * `delete` destroys the row. It is the one that needs the ceremony, and the ceremony here is
 * deliberately NOT a `--force`:
 *
 *   - it refuses unless the area is already archived, because archiving is one reversible command
 *     that makes you watch the thing stop being served before it is destroyed; and
 *   - it refuses while ANYTHING still references the area, naming each dependent, where the
 *     reference physically lives, and the verb that clears it.
 *
 * 🛑 There is no `--force` and adding one would be a mistake, not a convenience. `derivation delete`
 * has one because its dependents are mostly *reproducible* — a recompute rebuilds them. An area's
 * are not: a calendar feed token is a credential that cannot be re-minted at the same URL, and
 * `point_readings_flow_attr_1d` is the Sankey, which nothing heals. The refusal IS the confirmation
 * prompt, and clearing what it names is the confirmation.
 */
import { EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch, type ErrorOverride } from "@/lib/cli-kit/http";
import {
  BASE_URL_FLAG,
  bool,
  dependentLines,
  INCLUDE_ARCHIVED_FLAG,
  resolveArea,
  usage,
  type WireArea,
} from "../../shared";

const AREA_ARG = {
  name: "area",
  required: true,
  variadic: true,
  help: "One or more areas: ar_… id, integer handle, or display name",
} as const;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export const ARCHIVE_SPEC = {
  name: "archive",
  summary: "Retire an area: keep every row, stop serving it.",
  when:
    "Use this when an area should stop appearing and stop being served, but its history must stay\n" +
    "readable. It is also the required first step before `area delete`.",
  description:
    "REVERSIBLE. The row, its bindings and all of its derived history survive untouched; the area\n" +
    "leaves every listing and the KV subscription registry. `--undo` puts it back.\n" +
    "\n" +
    "Archiving is still gated: a dashboard naming the area would render nothing, with no error\n" +
    "anywhere, so anything that would go quiet is named first.",
  mutates: true,
  args: [AREA_ARG],
  flags: {
    ...BASE_URL_FLAG,
    undo: {
      type: "boolean",
      help: "Un-archive instead: set the area back to active",
    },
  },
  exitCodes: { 1: "the server refused (the reason names what would go quiet)" },
  examples: [
    "liveone area archive kinkora-fronius",
    "liveone area archive kinkora-fronius --apply",
    "liveone area archive kinkora-fronius --undo --apply",
  ],
} as const satisfies CommandSpec;

export const DELETE_SPEC = {
  name: "delete",
  summary:
    "Destroy an archived area's row. Irreversible, and refuses rather than forces.",
  when:
    "Use this to finally remove an area you have already archived and cleared. If you only want it\n" +
    "to stop being served, `area archive` is the whole operation.",
  description:
    "🛑 IRREVERSIBLE, and there is deliberately NO --force.\n" +
    "\n" +
    "Two interlocks, neither waivable:\n" +
    "  1. the area must already be ARCHIVED (`liveone area archive <area> --apply`);\n" +
    "  2. nothing may still reference it — the refusal names every dependent, the column it lives\n" +
    "     in, what would happen to it, and the verb that clears it.\n" +
    "\n" +
    "Clearing what it names IS the confirmation step. Typical order for a legacy shell area:\n" +
    "  liveone automation move <area> <automation> --to <other> --apply\n" +
    "  liveone calendar mint <other>    # then re-subscribe, check it renders, then revoke the old\n" +
    "  liveone area purge flows <area> --include-archived --start=… --end=… --apply\n" +
    "\n" +
    "The area's integer handle SURVIVES: `legacy_handles.area_id` is nulled, not deleted, so a\n" +
    "handle shared with a device keeps answering `?systemId=N` through the device.",
  mutates: true,
  args: [AREA_ARG],
  flags: { ...BASE_URL_FLAG, ...INCLUDE_ARCHIVED_FLAG },
  exitCodes: { 1: "the server refused (the reason names every dependent)" },
  examples: [
    "liveone area delete kinkora-fronius --include-archived",
    "liveone area delete kinkora-fronius --include-archived --apply",
  ],
} as const satisfies CommandSpec;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * 🛑 No "absent means everything". A variadic subject list whose empty case sweeps the fleet is one
 * mistyped shell expansion away from deleting every area you own — the same reasoning
 * `device config clean` states for its own subject list.
 *
 * 🛑 And this guard is LOad-BEARING, not belt-and-braces: `required: true` on a VARIADIC arg is not
 * enforced by `parse()` (a variadic arg's empty case is a valid parse), so `liveone area delete`
 * with no argument reaches the handler. Exported so that fact has a test of its own rather than
 * living only in whichever handler remembered to call it.
 */
export function subjects(ctx: Ctx): string[] {
  const refs = ctx.args.filter(Boolean);
  if (refs.length === 0)
    throw usage(
      "no area named",
      "this verb needs a subject, and there is deliberately no 'absent means everything'",
      "name one or more areas, e.g. `liveone area delete kinkora-fronius`",
    );
  return refs;
}

/**
 * The 409 contract both verbs share, rendered from the server's own `detail.dependents`.
 *
 * `next:` never mentions a force, because neither verb has one — an error message that suggests a
 * flag the parser rejects is worse than one that suggests nothing.
 */
interface WireDependent {
  kind: string;
  id: string;
  name: string | null;
  via: string;
  effect: string;
  fix: string;
}

/**
 * What the server would refuse over, asked BEFORE the write.
 *
 * 🛑 This is the difference between a preview and a guess. Without it both verbs printed "would
 * archive" / "would DELETE" and then `--apply` came back 409 — a dry run that promises something the
 * real thing deterministically refuses, which teaches people to skip the dry run. Advisory by
 * construction (the authoritative scan happens under a row lock inside the delete), and said so.
 */
async function previewDependents(
  s: ApiSession,
  areaId: string,
  destructive: boolean,
): Promise<WireDependent[]> {
  const { dependents } = await s.get<{ dependents: WireDependent[] }>(
    `/api/v4/areas/${encodeURIComponent(areaId)}/dependents${destructive ? "?destructive=true" : ""}`,
  );
  return dependents;
}

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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function runArchive(ctx: Ctx): Promise<number> {
  const refs = subjects(ctx);
  const undo = bool(ctx, "undo") === true;
  const status = undo ? "active" : "archived";

  return withApiSession(
    ctx,
    async (s) => {
      // An un-archive has to be able to SEE the archived row it is restoring; an archive does not.
      const areas: WireArea[] = [];
      for (const ref of refs)
        areas.push(await resolveArea(s, ref, { includeArchived: undo }));

      // Archiving is gated too — a dashboard naming the area would render nothing, silently. Only
      // asked when archiving; an UNDO removes no reference and cannot be refused for one.
      const blockers = new Map<string, WireDependent[]>();
      if (!undo)
        for (const a of areas) {
          const deps = await previewDependents(s, a.id!, false);
          if (deps.length > 0) blockers.set(a.id!, deps);
        }

      const done: Record<string, unknown>[] = [];
      if (!ctx.dryRun)
        for (const area of areas) {
          const res = await apiFetch<Record<string, unknown>>(
            s.origin,
            `/api/v4/areas/${area.id}`,
            {
              method: "PATCH",
              token: s.token,
              body: { status },
              errors: REFUSAL_ERRORS,
            },
          );
          done.push({ id: area.id, name: area.displayName, ...res.body });
        }

      ctx.emit(
        {
          status,
          applied: !ctx.dryRun,
          areas,
          done,
          blockers: Object.fromEntries(blockers),
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} set status=${status} on ${areas.length} area(s) at ${s.origin}`,
            ...areas.flatMap((a) => [
              `  ${a.displayName} (${a.id}) handle=${a.legacySystemId ?? "-"}`,
              ...(blockers.get(a.id!) ?? []).map(dependentLine),
            ]),
            undo
              ? "  the area returns to every listing and is served again"
              : "  every row survives — the area simply stops being listed and served",
            "",
            blockers.size > 0
              ? "🛑 the server WILL REFUSE this — resolve what is listed above first"
              : "",
            ctx.dryRun
              ? "Re-run with --apply to write."
              : `done. ${undo ? "" : "To destroy the row as well: `liveone area delete <area> --include-archived`"}`,
          ]
            .filter(Boolean)
            .join("\n"),
      );
      return blockers.size > 0 ? EXIT.FINDINGS : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function runDelete(ctx: Ctx): Promise<number> {
  const refs = subjects(ctx);
  const includeArchived = bool(ctx, "includeArchived") === true;

  return withApiSession(
    ctx,
    async (s) => {
      const areas: WireArea[] = [];
      for (const ref of refs)
        areas.push(await resolveArea(s, ref, { includeArchived }));

      // 🛑 Restated client-side. The dry run must never describe something --apply would refuse, and
      // an area that is not archived is refused — so say so HERE rather than let the operator spend
      // an --apply to find out. Same rule `derivation delete` follows for its disabled-first check.
      const active = areas.filter((a) => a.status && a.status !== "archived");
      if (active.length > 0)
        throw usage(
          `${active.map((a) => `${a.displayName} (${a.id})`).join(", ")} ${active.length === 1 ? "is" : "are"} not archived`,
          "delete is not the archive verb, and --apply would refuse: archiving first is one reversible command that lets you see what stops being served before anything is destroyed",
          `run \`liveone area archive ${active.map((a) => a.id).join(" ")} --apply\` first`,
        );

      // The DESTRUCTIVE question, asked before promising anything. Advisory: `hardDeleteArea`
      // re-scans under a row lock, because only a lock can make the answer true at the instant of
      // the delete. What this buys is that a dry run does not say "would DELETE" about an area with
      // 186 days of Sankey still attached.
      const blockers = new Map<string, WireDependent[]>();
      for (const a of areas) {
        const deps = await previewDependents(s, a.id!, true);
        if (deps.length > 0) blockers.set(a.id!, deps);
      }

      const deleted: Record<string, unknown>[] = [];
      if (!ctx.dryRun && blockers.size === 0)
        for (const area of areas) {
          const res = await apiFetch<{ deleted: Record<string, unknown> }>(
            s.origin,
            `/api/v4/areas/${area.id}`,
            { method: "DELETE", token: s.token, errors: REFUSAL_ERRORS },
          );
          deleted.push(res.body.deleted);
        }

      ctx.emit(
        {
          applied: !ctx.dryRun,
          areas,
          deleted,
          blockers: Object.fromEntries(blockers),
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} DELETE ${areas.length} area row(s) at ${s.origin}`,
            ...areas.flatMap((a) => [
              `  ${a.displayName} (${a.id}) handle=${a.legacySystemId ?? "-"}`,
              ...(blockers.get(a.id!) ?? []).map(dependentLine),
            ]),
            "  🛑 the row is destroyed — there is no undo and no --force",
            "  the integer handle survives: legacy_handles.area_id is nulled, not deleted, so a",
            "  handle shared with a device keeps resolving ?systemId=N through that device",
            "",
            blockers.size > 0
              ? "🛑 the server WILL REFUSE this — clear what is listed above first. There is no --force."
              : "",
            ctx.dryRun
              ? blockers.size > 0
                ? "Nothing to re-run yet."
                : "Re-run with --apply to delete."
              : `deleted ${deleted.length} area(s).`,
          ]
            .filter(Boolean)
            .join("\n"),
      );
      return blockers.size > 0 ? EXIT.FINDINGS : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

export const RETIRE_HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  archive: runArchive,
  delete: runDelete,
};
