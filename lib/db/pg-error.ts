/**
 * SQLSTATE extraction that survives drizzle's error wrapper.
 *
 * 🛑 Why this exists. `pg` puts the SQLSTATE on the error's own `code` field, so the idiom across this
 * repo has always been `(err as {code?: string}).code === "23505"`. Since drizzle-orm 0.44 every failed
 * query is re-thrown as a **`DrizzleQueryError`** — a plain `Error` carrying `query`/`params`, whose own
 * `code` is `undefined`; the `pg` error is one level down, on `.cause`. So that idiom silently stopped
 * matching, and every "collision → 409" branch written on top of it became an unhandled 500 with an
 * empty body. Measured 2026-07-31 against `liveone-dev`: `POST /api/v4/dashboards {slug: <taken>}` and
 * `PATCH /api/v4/dashboards/{id} {slug: <taken>}` both 500'd where the route documents 409.
 *
 * The walk is over the whole `cause` chain (not just one hop) so it keeps working if drizzle adds
 * another wrapper layer, and it matches on the code rather than trusting any single link.
 *
 * ⚠️ Do NOT reach for `err.constraint` to tell one unique index from another on this database. Measured
 * on `liveone-dev` (PlanetScale Postgres 17): a unique-index violation arrives with
 * `constraint`/`table`/`schema` all `undefined` — only `code`, `message` and `detail` are populated, and
 * the index name appears in the `message` text alone. Both `dashboards_owner_alias_unique` and
 * `areas_owner_alias_unique` are `uniqueIndex(...)`, not table constraints.
 *
 * ## 🛑 …and a migration would NOT fix that (Phase 14 stage 2b, measured 2026-07-31)
 *
 * The obvious remedy — "restate the unique INDEX as a NAMED table CONSTRAINT so `err.constraint`
 * arrives" — does not work here, and the measurement says so unambiguously. Forcing a **PRIMARY KEY**
 * violation (`share_tokens_pkey`, `points_pkey` — genuine `pg_constraint` entries, not indexes) against
 * `liveone-dev` produces exactly the same empty fields:
 *
 *     own enumerable keys: length name severity code detail hint position internalPosition
 *                          internalQuery where schema table column dataType constraint file line routine
 *     severity="ERROR"  code="23505"  file="nbtinsert.c"  line="666"  routine="_bt_check_unique"
 *     detail="Key (token)=(p14-pgerr-tok-z) already exists."
 *     schema=undefined  table=undefined  column=undefined  dataType=undefined  constraint=undefined
 *
 * `severity`/`code`/`detail`/`file`/`line`/`routine` survive; the five *object-identifying* ErrorResponse
 * fields (`s`/`t`/`c`/`d`/`n`) are stripped by PlanetScale's Postgres proxy for every error, constraint
 * or index alike. So there is no schema change that would populate `constraint`, and the only field that
 * names the violated unique on this database is the server's `message`:
 *
 *     duplicate key value violates unique constraint "areas_owner_alias_unique"
 *
 * That is what {@link violatedUniqueName} reads — preferring `constraint` when a stock Postgres does
 * supply it (so the helper stays correct off PlanetScale), and falling back to the message otherwise.
 */

/** The subset of a `pg` error this module reads. */
interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  detail?: unknown;
  message?: unknown;
}

/**
 * The first link in `err`'s `cause` chain carrying this SQLSTATE, or `undefined`.
 *
 * The walk is over the whole chain (not just one hop) so it keeps working if drizzle adds another
 * wrapper layer, and the depth bound makes it total on a cyclic `cause`.
 */
function linkWithCode(err: unknown, code: string): PgErrorLike | undefined {
  let node: unknown = err;
  for (let depth = 0; node != null && depth < 8; depth++) {
    if (typeof node !== "object") break;
    if ((node as PgErrorLike).code === code) return node as PgErrorLike;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Walk `err` and its `cause` chain; true when any link carries this SQLSTATE. */
export function hasPgErrorCode(err: unknown, code: string): boolean {
  return linkWithCode(err, code) !== undefined;
}

/** Postgres `unique_violation` (SQLSTATE 23505), through drizzle's wrapper. */
export function isPgUniqueViolation(err: unknown): boolean {
  return hasPgErrorCode(err, "23505");
}

/** `duplicate key value violates unique constraint "<name>"` — the ONLY carrier of the name here. */
const UNIQUE_NAME_IN_MESSAGE = /violates unique constraint "([^"]+)"/;

/**
 * The name of the unique index/constraint a 23505 violated — `undefined` for any other error.
 *
 * Reads `constraint` first (a stock Postgres populates it) and falls back to the `message` text, which
 * is where PlanetScale leaves it. Read the module docstring before "simplifying" this to `err.constraint`:
 * on this database that field is ALWAYS undefined, so the simplification silently never matches.
 */
export function violatedUniqueName(err: unknown): string | undefined {
  const link = linkWithCode(err, "23505");
  if (!link) return undefined;
  if (typeof link.constraint === "string" && link.constraint)
    return link.constraint;
  if (typeof link.message !== "string") return undefined;
  return UNIQUE_NAME_IN_MESSAGE.exec(link.message)?.[1];
}

/**
 * True when `err` is a unique violation on exactly `uniqueName`.
 *
 * Deliberately STRICT: a 23505 whose name cannot be determined returns false and the caller rethrows.
 * A "collision → 409" branch that fires on the wrong unique is worse than a 500 — it would report
 * "that shortname is taken" for, say, a handle-mapping clash, and hide a real bug behind a plausible
 * user-facing message.
 */
export function isUniqueViolationOn(err: unknown, uniqueName: string): boolean {
  return violatedUniqueName(err) === uniqueName;
}

/**
 * The pg `detail` line of a 23505 — `Key (owner_user_id, slug)=(user_x, taken) already exists.`
 *
 * For diagnostics only. It embeds the colliding VALUES, so never put it in a client-facing response.
 */
export function uniqueViolationDetail(err: unknown): string | undefined {
  const link = linkWithCode(err, "23505");
  return typeof link?.detail === "string" ? link.detail : undefined;
}
