/**
 * The dashboard domain's transport seam — the SAME verbs over two very different wires.
 *
 *   http  (default)  the deployed API, authenticated as YOU via a `lo_cli_` token. Every write goes
 *                    through the route's full check stack — validateDocV4 AND checkDocRefsReadable —
 *                    so this path is strictly better-guarded than direct SQL.
 *   db               direct Postgres via MIGRATE_DATABASE_URL. The permanent escape hatch: a doc
 *                    whose refs the owner cannot read can ONLY be repaired here (the repairing PUT
 *                    would itself be 403'd), and it works during an outage or against a build that
 *                    predates a card type. Explicit only — an ambient env var must never silently
 *                    choose the target.
 *
 * The interface deliberately carries `checkRef` as OPTIONAL: it exists on db (existence pre-check +
 * the scope-widening warning) and is ABSENT on http, where the PUT's own server-side readability
 * check covers existence AND authorization — pre-querying would duplicate a weaker version of it.
 *
 * Rows carry the opaque `db_…` TypeID. The db implementation keeps the raw uuid to itself in a
 * WeakMap, so nothing above the transport ever touches `lib/ids` decoding.
 */
import type { Client } from "pg";
import { Dashboard } from "@/lib/ids";
import { countCardNodes, isDashboardV4 } from "@/lib/dashboard/v4";
import { EXIT, failWith, type Ctx } from "@/lib/cli/cli";
import { isAliasCollision } from "@/lib/dashboard/dashboards";
import { apiFetch } from "@/lib/cli-kit/http";
import {
  normalizeOrigin,
  readStore,
  tokenFor,
} from "@/lib/cli-kit/token-store";
import {
  connect,
  listDashboards,
  printTarget,
  resolveDashboard,
  writeDoc,
  type DashRow,
} from "./db";

export const DEFAULT_ORIGIN = "https://www.liveone.energy";

export interface ListEntry {
  id: string;
  name: string | null;
  slug: string | null;
  cardCount: number | null;
  revision: number;
  updatedAt: string;
  /** db transport: the owner's user id. */
  owner?: string;
  /** http transport: how the CALLER reaches it — the API is caller-scoped, not owner-scoped. */
  access?: "owner" | "shared";
}

export interface DashRowLike {
  /** Opaque `db_…` TypeID, both transports. */
  id: string;
  name: string | null;
  slug: string | null;
  revision: number;
  doc: unknown;
  owner?: string;
}

export interface DashboardTransport {
  kind: "db" | "http";
  /** The target line, to stderr, before any work. READ IT before --apply. */
  describeTarget(mode: string): Promise<void>;
  list(owner?: string): Promise<ListEntry[]>;
  resolve(ref: string): Promise<DashRowLike>;
  /** CAS write; returns the new revision. `savedVia` reserved for the revisions tranche. */
  writeDoc(row: DashRowLike, doc: unknown): Promise<{ revision: number }>;
  patchMeta(
    row: DashRowLike,
    patch: { name?: string | null; slug?: string | null },
  ): Promise<void>;
  /** db only. http relies on the PUT's server-side checkDocRefsReadable. */
  checkRef?(kind: "area" | "device", value: string): Promise<void>;
  close(): Promise<void>;
}

export function dashLabelLike(row: DashRowLike): string {
  return `${row.name ?? "(unnamed)"} (${row.id}, rev ${row.revision})`;
}

// ---------------------------------------------------------------------------
// db
// ---------------------------------------------------------------------------

function makeDbTransport(client: Client, ctx: Ctx): DashboardTransport {
  // Raw uuids never leave this closure — everything above sees db_… TypeIDs only.
  const rawIds = new WeakMap<DashRowLike, string>();

  const toLike = (r: DashRow): DashRowLike => {
    const like: DashRowLike = {
      id: Dashboard.encode(r.id),
      name: r.name,
      slug: r.slug,
      revision: r.revision,
      doc: r.doc,
      owner: r.ownerUserId,
    };
    rawIds.set(like, r.id);
    return like;
  };

  return {
    kind: "db",
    describeTarget: (mode) => printTarget(client, mode),
    list: async (owner) =>
      (await listDashboards(client, owner)).map((r) => ({
        id: Dashboard.encode(r.id),
        name: r.name,
        slug: r.slug,
        cardCount: isDashboardV4(r.doc) ? countCardNodes(r.doc) : null,
        revision: r.revision,
        updatedAt: r.updatedAt.toISOString(),
        owner: r.ownerUserId,
      })),
    resolve: async (ref) => toLike(await resolveDashboard(client, ref)),
    writeDoc: async (row, doc) => {
      const raw = rawIds.get(row);
      if (!raw)
        throw new Error("writeDoc: row did not come from this transport");
      await writeDoc(client, { id: raw, revision: row.revision }, doc);
      return { revision: row.revision + 1 };
    },
    patchMeta: async (row, patch) => {
      const raw = rawIds.get(row);
      if (!raw)
        throw new Error("patchMeta: row did not come from this transport");
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.name !== undefined) {
        params.push(patch.name);
        sets.push(`name = $${params.length}`);
      }
      if (patch.slug !== undefined) {
        params.push(patch.slug);
        sets.push(`slug = $${params.length}`);
      }
      params.push(raw);
      try {
        await client.query(
          `update dashboards set ${sets.join(", ")}, updated_at = now() where id = $${params.length}`,
          params,
        );
      } catch (err) {
        if (isAliasCollision(err))
          throw failWith(
            EXIT.FINDINGS,
            `slug "${patch.slug}" is already taken`,
            "another of the owner's dashboards already uses it",
            "pick a different shortname",
          );
        throw err;
      }
    },
    checkRef: async (kind, value) => {
      const table = kind === "area" ? "areas" : "devices";
      const codec = kind === "area" ? "ar" : "dv";
      const { Area, Device } = await import("@/lib/ids");
      const uuid = (kind === "area" ? Area : Device).toUuidOrNull(value);
      if (!uuid)
        throw failWith(
          EXIT.USAGE,
          `"${value}" for --${kind}`,
          `--${kind} expects a ${kind} id`,
          `pass a ${codec}_… id`,
        );
      const res = await client.query(`select 1 from ${table} where id = $1`, [
        uuid,
      ]);
      if (res.rowCount === 0)
        throw failWith(
          EXIT.USAGE,
          `--${kind}: no ${kind} ${value} in the target database`,
          "the id is well-formed but names nothing here",
          "check you are pointed at the right database — ids are per-environment",
        );
      // The bypass consequence, said out loud on every db-path ref write. Over http the server's
      // checkDocRefsReadable enforces this instead of warning about it.
      ctx.warn(
        `warning: readability of ${value} is NOT checked — on a shared dashboard this ref widens what ` +
          `anonymous viewers can query, and a ref the owner cannot read locks the doc out of the web editor`,
      );
    },
    close: () => client.end(),
  };
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

interface WireListRow {
  id: string;
  name: string | null;
  slug: string | null;
  cardCount: number;
  revision: number;
  updatedAt: string;
  access: "owner" | "shared";
}

function makeHttpTransport(origin: string, token: string): DashboardTransport {
  const get = <T>(path: string) => apiFetch<T>(origin, path, { token });

  const getOne = async (id: string): Promise<DashRowLike> => {
    const { body } = await get<{
      id: string;
      name: string | null;
      slug: string | null;
      revision: number;
      doc: unknown;
    }>(`/api/v4/dashboards/${encodeURIComponent(id)}`);
    return {
      id: body.id,
      name: body.name,
      slug: body.slug,
      revision: body.revision,
      doc: body.doc,
    };
  };

  return {
    kind: "http",
    describeTarget: async (mode) => {
      const { body: who } = await get<Record<string, unknown>>(
        "/api/cli-auth/whoami",
      );
      process.stderr.write(
        `target: ${origin} as ${who.email ?? who.userId}${who.isAdmin ? " (admin)" : ""} · ` +
          `clerk ${who.clerkInstance} · db ${who.dbHost} · build ${who.buildSha ?? "?"}   mode: ${mode}\n`,
      );
      if (
        mode === "APPLY" &&
        /\.vercel\.app$|\.preview\.liveone\.energy$/.test(new URL(origin).host)
      )
        process.stderr.write(
          "note: preview build — writes land in the dev database and are reverted by the prod→dev sync\n",
        );
    },
    list: async (owner) => {
      if (owner !== undefined)
        throw failWith(
          EXIT.USAGE,
          "--owner with --via=http",
          "the API lists YOUR dashboards (owned + shared); it is caller-scoped, not owner-filtered",
          "drop --owner, or use --via=db",
        );
      const { body } = await get<{ dashboards: WireListRow[] }>(
        "/api/v4/dashboards",
      );
      return body.dashboards.map((d) => ({ ...d }));
    },
    resolve: async (ref) => {
      if (ref.startsWith("db_")) return getOne(ref);
      // Slug resolution is client-side over the caller-scoped list — the same ambiguity rule as
      // the db transport, which matters because the list can hold a shared dashboard whose slug
      // collides with an owned one.
      const { body } = await get<{ dashboards: WireListRow[] }>(
        "/api/v4/dashboards",
      );
      const hits = body.dashboards.filter((d) => d.slug === ref);
      if (hits.length === 0)
        throw failWith(
          EXIT.USAGE,
          `no dashboard matches "${ref}"`,
          "nothing you can access has that id or slug",
          "run `liveone dashboard list` — ids are per-environment",
        );
      if (hits.length > 1)
        throw failWith(
          EXIT.USAGE,
          `slug "${ref}" is ambiguous`,
          `it names ${hits.length} dashboards you can access:\n${hits.map((h) => `  ${h.id} (${h.access})`).join("\n")}`,
          "address it by its db_… id instead",
        );
      return getOne(hits[0].id);
    },
    writeDoc: async (row, doc) => {
      const { body } = await apiFetch<{ revision: number }>(
        origin,
        `/api/v4/dashboards/${encodeURIComponent(row.id)}`,
        { method: "PUT", body: { doc }, ifMatch: row.revision, token },
      );
      return { revision: body.revision };
    },
    patchMeta: async (row, patch) => {
      await apiFetch(
        origin,
        `/api/v4/dashboards/${encodeURIComponent(row.id)}`,
        {
          method: "PATCH",
          body: patch,
          token,
        },
      );
    },
    // no checkRef: the PUT's checkDocRefsReadable covers existence AND readability server-side.
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

/**
 * Build the transport the flags asked for. `--via=http` is the default; `--via=db` is explicit
 * only and keeps its own credential story (MIGRATE_DATABASE_URL / the liveone:dev fallback).
 */
export async function makeTransport(ctx: Ctx): Promise<DashboardTransport> {
  const via = (ctx.flags.via as string | undefined) ?? "http";
  if (via === "db") {
    const client = await connect();
    return makeDbTransport(client, ctx);
  }
  const origin = normalizeOrigin(
    (ctx.flags.baseUrl as string | undefined) ??
      process.env.LIVEONE_BASE_URL ??
      readStore().defaultOrigin ??
      DEFAULT_ORIGIN,
  );
  const entry = tokenFor(origin);
  if (!entry)
    throw failWith(
      EXIT.AUTH,
      `not logged in to ${origin}`,
      "the http transport needs a CLI token for the origin it calls",
      `run \`liveone auth login --base-url=${origin}\` (or use --via=db with MIGRATE_DATABASE_URL)`,
    );
  return makeHttpTransport(origin, entry.token);
}

export async function withTransport<T>(
  ctx: Ctx,
  fn: (t: DashboardTransport) => Promise<T>,
): Promise<T> {
  const t = await makeTransport(ctx);
  try {
    return await fn(t);
  } finally {
    await t.close();
  }
}
