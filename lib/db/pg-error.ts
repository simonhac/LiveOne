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
 */

/** Walk `err` and its `cause` chain; true when any link carries this SQLSTATE. */
export function hasPgErrorCode(err: unknown, code: string): boolean {
  let node: unknown = err;
  for (let depth = 0; node != null && depth < 8; depth++) {
    if (typeof node !== "object") break;
    if ((node as { code?: unknown }).code === code) return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

/** Postgres `unique_violation` (SQLSTATE 23505), through drizzle's wrapper. */
export function isPgUniqueViolation(err: unknown): boolean {
  return hasPgErrorCode(err, "23505");
}
