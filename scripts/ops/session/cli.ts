/**
 * The `session` domain of the `liveone` CLI — the provenance record a write is filed under.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 *
 * Every reading in LiveOne carries a `session_id`, and for a poll that is automatic: the collector
 * opens one, the vendor's raw payload is archived into it, and closing it is what publishes. This
 * domain exists for the one case with no vendor on the other end — `liveone import`, which writes
 * numbers an operator supplies.
 *
 * 🛑 **This is what makes `import --quality=good` honest rather than laundering.** The rule the
 * codebase settled on (`lib/vendors/sigenergy/derive-power.ts`) is that a quality marker grades
 * CONFIDENCE, not provenance — a vendor's own late-arriving sample is written `good`, because it is
 * the same number the poll would have captured, and "using a quality marker to carry provenance is
 * the mistake Amber's abbreviation already made". That rule only holds while the other half of it
 * does: "which rows arrived this way is answerable from `session_id`". A session with no label and
 * no manifest keeps the foreign key and throws away the answer.
 *
 * So `create` requires BOTH a label (how a human finds it again) and a manifest (where the data
 * came from), and `show` is what turns a row's `session_id` back into that record.
 */
import fs from "node:fs";
import { defineCommand, EXIT, str, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { BASE_URL_FLAG, resolveDevice, usage } from "../shared";

interface WireSession {
  id: string;
  label: string | null;
  cause: string;
  successful: boolean | null;
  numRows: number;
  createdAt: string;
}

interface WireCreate {
  session: WireSession & { deviceRid: number };
  dryRun: boolean;
  created: boolean;
}

interface WireShow {
  session: WireSession & {
    device: { id: string; systemId: number; name: string };
    duration: number;
    errorCode: string | null;
    error: string | null;
    manifest: unknown;
  };
}

interface WireList {
  device: { id: string; systemId: number };
  sessions: WireSession[];
}

export const sessionCommand = defineCommand({
  name: "session",
  summary:
    "The provenance record a write is filed under — create one, and read it back.",
  when:
    "Create a session before `liveone import`, which requires one: it is the only record of where\n" +
    "operator-supplied rows came from. `show` answers the question a reader actually arrives with —\n" +
    "'this number has session_id X, what is X?'",
  description:
    "`create` writes and is dry-run by default; `show` and `list` read.\n\n" +
    "Admin/owner only, http-only. Prints `target: <origin> as <you>` on stderr first.\n\n" +
    "A poll opens its own session and archives the vendor's raw payload into it. An import has no\n" +
    "vendor, so you supply the equivalent: --label, and a --manifest naming the source, its\n" +
    "checksums, the mapping applied and the tool that built it.",
  uses: ["api"],
  subcommands: {
    create: {
      name: "create",
      summary: "Mint a session to file an import under.",
      when:
        "Run this once per repair job, then pass the id to every `liveone import` it covers.\n" +
        "One job is several imports — chunked, per point, sometimes days apart — and they must all\n" +
        "resolve to the same record, which is why `import` will not mint one for itself.",
      args: [
        {
          name: "device",
          required: true,
          help: "A device: its dv_… id, integer handle, slug, or name",
        },
      ],
      flags: {
        ...BASE_URL_FLAG,
        label: {
          type: "string",
          placeholder: "text",
          help: "REQUIRED — how a human finds this again. Say what was repaired and when, not 'import'.",
        },
        manifest: {
          type: "string",
          placeholder: "path",
          help: "REQUIRED — a JSON file recording WHERE the data came from. `-` reads it from stdin.",
        },
      },
      mutates: true,
      examples: [
        "liveone session create 6 --label='mondo archive soc 2025-10..2026-09' --manifest=m.json",
        "liveone session create 6 --label='…' --manifest=m.json --apply",
      ],
    },
    show: {
      name: "show",
      summary: "One session, with its manifest.",
      when:
        "The answer to 'where did this reading come from?'. Takes the bare session id — you arrive\n" +
        "here from a row, which knows its session but not necessarily its device.",
      args: [
        { name: "session", required: true, help: "A session id (uuidv7)" },
      ],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone session show 01a08f2e-9aa1-7917-a3bc-35663ac62736"],
    },
    list: {
      name: "list",
      summary: "A device's recent sessions — id, label, cause, rows.",
      when:
        "For finding the id to `show`. The manifest is deliberately not here: it is unbounded, and\n" +
        "a list is for choosing.",
      args: [
        {
          name: "device",
          required: true,
          help: "A device: its dv_… id, integer handle, slug, or name",
        },
      ],
      flags: {
        ...BASE_URL_FLAG,
        limit: {
          type: "string",
          placeholder: "n",
          help: "How many to return, newest first (default 20, max 200)",
        },
        cause: {
          type: "string",
          placeholder: "cause",
          help: "Only sessions with this cause, e.g. ADMIN for the operator-driven ones",
        },
      },
      examples: [
        "liveone session list 6",
        "liveone session list 6 --cause=ADMIN --limit=5",
      ],
    },
  },
});

async function devicePath(s: ApiSession, ref: string): Promise<string> {
  const device = await resolveDevice(s, ref);
  if (!device.id)
    throw usage(
      `device ${ref} has no dv_ id on this origin`,
      "session addresses a device by its TypeID",
      "run `liveone device list` to see the ids this origin serves",
    );
  return `/api/v4/devices/${device.id}/sessions`;
}

async function runCreate(ctx: Ctx): Promise<number> {
  const ref = ctx.args[0];
  const label = str(ctx, "label");
  if (!label)
    throw usage(
      "--label is required",
      "a session with no label is a foreign key with the answer thrown away",
      "--label='what was repaired, and when'",
    );
  const manifestPath = str(ctx, "manifest");
  if (!manifestPath)
    throw usage(
      "--manifest is required",
      "the manifest is the record of WHERE the data came from — the point of the session",
      "--manifest=manifest.json, or --manifest=- to read it from stdin",
    );

  const text =
    manifestPath === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(manifestPath, "utf8");
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw usage(
      `--manifest is not valid JSON: ${manifestPath}`,
      e instanceof Error ? e.message : String(e),
      "it is stored as jsonb, so it has to parse before it can be filed",
    );
  }

  return withApiSession(
    ctx,
    async (s) => {
      const path = await devicePath(s, ref);
      const res = await apiFetch<WireCreate>(s.origin, path, {
        method: "POST",
        body: { label, manifest, dryRun: ctx.dryRun },
        token: s.token,
      });
      const r = res.body;
      ctx.emit(r, () =>
        [
          `${r.created ? "created" : "would create"}  session for device ${r.session.deviceRid}`,
          `id       ${r.session.id}`,
          `label    ${r.session.label}`,
          r.created
            ? `next: liveone import <device> --file=… --quality=… --session=${r.session.id}`
            : "dry run — nothing was written. Re-run with --apply.",
        ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function runShow(ctx: Ctx): Promise<number> {
  const id = ctx.args[0];
  return withApiSession(ctx, async (s) => {
    const res = await apiFetch<WireShow>(s.origin, `/api/v4/sessions/${id}`, {
      token: s.token,
    });
    const x = res.body.session;
    ctx.emit(res.body, () =>
      [
        `session  ${x.id}`,
        `label    ${x.label ?? "(none)"}`,
        `device   ${x.device.id}  ${x.device.name}  (handle ${x.device.systemId})`,
        `cause    ${x.cause}   rows ${x.numRows}   created ${x.createdAt}`,
        x.error ? `error    ${x.errorCode ?? ""} ${x.error}` : null,
        "manifest",
        JSON.stringify(x.manifest, null, 2)
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n"),
      ]
        .filter((l): l is string => l !== null)
        .join("\n"),
    );
    return EXIT.OK;
  });
}

async function runList(ctx: Ctx): Promise<number> {
  const ref = ctx.args[0];
  const limit = str(ctx, "limit");
  const cause = str(ctx, "cause");
  return withApiSession(ctx, async (s) => {
    const base = await devicePath(s, ref);
    const q = new URLSearchParams();
    if (limit) q.set("limit", limit);
    if (cause) q.set("cause", cause);
    const path = q.size > 0 ? `${base}?${q}` : base;
    const res = await apiFetch<WireList>(s.origin, path, { token: s.token });
    const r = res.body;
    ctx.emit(r, () =>
      r.sessions.length === 0
        ? "no sessions"
        : r.sessions
            .map(
              (x) =>
                `${x.createdAt}  ${x.id}  ${x.cause.padEnd(6)} ${String(x.numRows).padStart(7)} row(s)  ${x.label ?? "(no label)"}`,
            )
            .join("\n"),
    );
    // Nothing found is a finding, not a success: `list` is usually a step towards `show`.
    return r.sessions.length > 0 ? EXIT.OK : EXIT.FINDINGS;
  });
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  create: runCreate,
  show: runShow,
  list: runList,
};

export async function runSession(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown session command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- session --help`",
    );
  return handler(ctx);
}
