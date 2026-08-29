/**
 * Connection + row plumbing for the dashboard CLI — mirrors `scripts/utils/migrate-card-type.ts`
 * (the canonical config-document script) exactly. See the header of `cli.ts` for the operational
 * ritual; the safety reasoning lives here with the code it guards.
 *
 * The connection comes from `MIGRATE_DATABASE_URL` and nothing else — deliberately NOT the ambient
 * `PLANETSCALE_DATABASE_URL`, because this tool's durable target is PROD and "which database am I
 * pointed at" must never be answered by whatever happens to be in `.env.local`.
 *
 * It deliberately does NOT try to auto-detect "am I on prod". The usual `PLANETSCALE_PROD_BRANCH_ID`
 * check matches the branch id inside a `postgres.<branch-id>` username, but a freshly minted
 * `pscale role` connects as `pscale_api_…` and carries no branch id — so the check would report a
 * confident "not prod" for the exact connection this tool is normally pointed at. A false
 * reassurance is worse than none; the printed identity is the check.
 */
import { Client } from "pg";
import { Dashboard } from "@/lib/ids";
import { UsageError } from "./args";

export async function connect(): Promise<Client> {
  let raw = process.env.MIGRATE_DATABASE_URL;
  // `npm run dashboard:dev` sets DASHBOARD_DEV_FALLBACK=1 and loads .env.local via tsx --env-file,
  // allowing the ambient dev URL — but ONLY behind that explicit gate, and never a URL carrying the
  // prod branch id. Plain `npm run dashboard` stays MIGRATE_DATABASE_URL-only: an ambient variable
  // must not silently choose the target. (This fallback direction is fail-closed: the token is
  // present iff the URL is prod. The unreliable direction — "no token, therefore not prod", which a
  // minted pscale_api_… role would trip — is never relied on; see the module header.)
  if (!raw && process.env.DASHBOARD_DEV_FALLBACK === "1") {
    const dev = process.env.PLANETSCALE_DATABASE_URL;
    const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID;
    if (dev && prodToken && dev.includes(prodToken)) {
      throw new Error(
        "dashboard:dev refuses to run: PLANETSCALE_DATABASE_URL carries the prod branch id",
      );
    }
    raw = dev;
  }
  if (!raw) {
    throw new Error(
      "set MIGRATE_DATABASE_URL to the connection string of the database to target\n" +
        // .env.local is NOT sourced into your shell, so $PLANETSCALE_DATABASE_URL expands empty —
        // the hint must be a command that actually works.
        "  dev:  npm run dashboard:dev -- <command> …   (reads .env.local), or\n" +
        "        MIGRATE_DATABASE_URL=$(grep '^PLANETSCALE_DATABASE_URL=' .env.local | cut -d= -f2-) npm run dashboard -- …\n" +
        "  prod: pscale role create liveone sydney dash-cli --inherited-roles postgres --ttl 1h",
    );
  }
  // `pg` rejects the PlanetScale ssl params; strip them exactly as getPoolConfig does for the pool.
  const u = new URL(raw);
  for (const p of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    u.searchParams.delete(p);
  }
  const client = new Client({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

/**
 * Print the connected identity + mode BEFORE any work — to stderr, so `--json` output on stdout
 * stays machine-clean. Read this line before you pass `--apply`: it IS the prod/dev check.
 */
export async function printTarget(client: Client, mode: string): Promise<void> {
  const who = await client.query("select current_user, current_database()");
  console.error(
    `target: ${who.rows[0].current_database} as ${who.rows[0].current_user} @ ${client.host}   mode: ${mode}`,
  );
}

export interface DashRow {
  id: string; // raw uuid (stays inside the script; display via Dashboard.encode)
  legacyId: number | null;
  ownerUserId: string;
  name: string | null;
  slug: string | null;
  revision: number;
  doc: unknown;
  updatedAt: Date;
}

const ROW_COLUMNS =
  "id, legacy_id, owner_user_id, name, slug, revision, doc, updated_at";

function toRow(r: Record<string, unknown>): DashRow {
  return {
    id: r.id as string,
    legacyId: r.legacy_id as number | null,
    ownerUserId: r.owner_user_id as string,
    name: r.name as string | null,
    slug: r.slug as string | null,
    revision: r.revision as number,
    doc: r.doc,
    updatedAt: r.updated_at as Date,
  };
}

export async function listDashboards(
  client: Client,
  owner?: string,
): Promise<DashRow[]> {
  // Presence check, not truthiness: an empty string must filter (to zero rows), never silently
  // widen the query to every owner. The CLI rejects `--owner=` upstream anyway.
  const res = await client.query(
    `select ${ROW_COLUMNS} from dashboards
      ${owner !== undefined ? "where owner_user_id = $1" : ""}
      order by owner_user_id, name nulls last, id`,
    owner !== undefined ? [owner] : [],
  );
  return res.rows.map(toRow);
}

/** A dashboard's display label for CLI output. */
export function dashLabel(row: DashRow): string {
  return `${row.name ?? "(unnamed)"} (${Dashboard.encode(row.id)}, rev ${row.revision})`;
}

/**
 * Resolve `<dash>` — a `db_…` TypeID, a bare integer (`legacy_id`), or a slug. A slug that matches
 * more than one owner's dashboard is ambiguous → usage error listing the candidates.
 */
export async function resolveDashboard(
  client: Client,
  ref: string,
): Promise<DashRow> {
  let where: string;
  let param: string | number;
  if (ref.startsWith("db_")) {
    const uuid = Dashboard.toUuidOrNull(ref);
    if (!uuid) throw new UsageError(`not a valid dashboard id: ${ref}`);
    where = "id = $1";
    param = uuid;
  } else if (/^\d+$/.test(ref)) {
    where = "legacy_id = $1";
    param = Number(ref);
  } else {
    where = "slug = $1";
    param = ref;
  }
  let res = await client.query(
    `select ${ROW_COLUMNS} from dashboards where ${where}`,
    [param],
  );
  // An all-digit ref is tried as legacy_id first, but `isValidAlias` permits all-digit slugs
  // (e.g. "2025") — on a legacy_id miss, fall through to the slug lookup so such a dashboard is
  // still addressable. (If BOTH exist, legacy_id wins; use the db_… id to disambiguate.)
  if (res.rowCount === 0 && where === "legacy_id = $1") {
    res = await client.query(
      `select ${ROW_COLUMNS} from dashboards where slug = $1`,
      [ref],
    );
  }
  if (res.rowCount === 0) throw new Error(`no dashboard matches "${ref}"`);
  if ((res.rowCount ?? 0) > 1) {
    const candidates = res.rows
      .map((r) => `  ${r.owner_user_id}/${r.slug} (${Dashboard.encode(r.id)})`)
      .join("\n");
    throw new UsageError(
      `slug "${ref}" is ambiguous across owners — use the db_… id:\n${candidates}`,
    );
  }
  return toRow(res.rows[0]);
}

/**
 * CAS write of a new doc: lock the row, assert the revision is still the one we read, bump it.
 * Mirrors `updateDashboardDoc`, so a concurrent editor's `If-Match` conflicts instead of being
 * clobbered.
 */
export async function writeDoc(
  client: Client,
  row: Pick<DashRow, "id" | "revision">,
  doc: unknown,
): Promise<void> {
  await client.query("begin");
  try {
    const locked = await client.query<{ revision: number }>(
      "select revision from dashboards where id = $1 for update",
      [row.id],
    );
    if (locked.rows[0]?.revision !== row.revision) {
      throw new Error(
        `revision moved under us (${row.revision} -> ${locked.rows[0]?.revision}); re-run`,
      );
    }
    await client.query(
      "update dashboards set doc = $1, revision = revision + 1, updated_at = now() where id = $2",
      [JSON.stringify(doc), row.id],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}
