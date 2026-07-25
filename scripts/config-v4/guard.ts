/**
 * Shared fail-closed target guard + raw-pool config for the config-v4 cutover scripts.
 *
 * The branch id lives in the connection USERNAME (pscale_api_<role>.<branchid>) — used for routing, NOT
 * in Postgres current_user (just the role). So the guard keys off the URL, not a DB query.
 *
 * THREE sanctioned targets, selected by `CONFIG_V4_TARGET` (default `rehearsal`). The mode is what the
 * operator ASSERTS; the branch-id env var is the positive proof of that assertion:
 *
 *   rehearsal — a throwaway prod-snapshot branch. Requires REHEARSAL_BRANCH_ID; refuses the prod token.
 *   dev       — `liveone-dev`, the Group-C dress rehearsal. Requires LIVEONE_DEV_BRANCH_ID; refuses prod.
 *   prod      — the real window. INVERTS the refusal: requires PLANETSCALE_PROD_BRANCH_ID to be PRESENT
 *               in the username, plus an explicit `--i-understand-this-is-prod` argv flag.
 *
 * Why the modes exist: the original guard hard-required REHEARSAL_BRANCH_ID and refused the prod token
 * outright, so `config-transform`/`parity-check`/`authz-check` had NO sanctioned way to run in either
 * window. The operator's only route was to set REHEARSAL_BRANCH_ID to the prod branch id — which both
 * defeats the guard and is indistinguishable from doing it by accident. A named mode plus an explicit
 * flag makes "I meant prod" a deliberate, greppable act rather than 3am env-var surgery.
 *
 * ⚠️  This guard is NOT the first thing that runs. Every config-v4 script imports `@/lib/db/planetscale`,
 *     whose pool setup calls `assertDbEnvironmentMatches` and hard-throws for a prod-token connection
 *     outside `VERCEL_ENV=production`. So a prod-mode run ALSO needs `ALLOW_PROD_DB_IN_DEV=true` (the
 *     documented escape hatch — CLAUDE.md); without it the run dies earlier, complaining about something
 *     else. Every prod usage line in these scripts sets it.
 */

type Target = "rehearsal" | "dev" | "prod";

export function assertRehearsalTarget(): void {
  const mode = (process.env.CONFIG_V4_TARGET ?? "rehearsal") as Target;
  const url = process.env.PLANETSCALE_DATABASE_URL;
  if (!url) throw new Error("PLANETSCALE_DATABASE_URL unset");
  const u = new URL(url);
  const username = decodeURIComponent(u.username).toLowerCase();
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID?.toLowerCase();
  const where = `${u.username}@${u.host}`;

  // Required in EVERY mode, not just prod. `PLANETSCALE_PROD_BRANCH_ID` is the ONLY thing that can
  // identify prod — PlanetScale puts every branch in a region behind one hostname and tells them apart by
  // the username — so guarding it as `prodToken && …` fails OPEN exactly where it matters: on a CI runner
  // or a partial `.env.local`, `REHEARSAL_BRANCH_ID=<prod branch id>` against the prod URL would sail
  // through and transform prod. Fail closed instead.
  if (!prodToken)
    throw new Error(
      "REFUSING: PLANETSCALE_PROD_BRANCH_ID is unset, so this guard cannot tell prod from a rehearsal branch. Set it (CLAUDE.md requires it in every scope) before running any config-v4 script.",
    );

  if (mode === "prod") {
    if (!process.argv.includes("--i-understand-this-is-prod"))
      throw new Error(
        "REFUSING: CONFIG_V4_TARGET=prod also requires the explicit --i-understand-this-is-prod flag.",
      );
    if (!username.includes(prodToken))
      throw new Error(
        `REFUSING: ${where} does NOT carry the prod branch token — CONFIG_V4_TARGET=prod, but this is not prod.`,
      );
    console.log(`✓ target confirmed: ${where} (PROD — irreversible window)`);
    return;
  }

  // rehearsal + dev: never prod.
  if (username.includes(prodToken))
    throw new Error(
      `REFUSING: ${where} carries the PROD branch token but CONFIG_V4_TARGET=${mode}. Set CONFIG_V4_TARGET=prod (plus --i-understand-this-is-prod) if that is genuinely what you mean.`,
    );

  const [varName, expected] =
    mode === "dev"
      ? (["LIVEONE_DEV_BRANCH_ID", process.env.LIVEONE_DEV_BRANCH_ID] as const)
      : (["REHEARSAL_BRANCH_ID", process.env.REHEARSAL_BRANCH_ID] as const);
  if (!expected)
    throw new Error(
      `REFUSING: CONFIG_V4_TARGET=${mode} — set ${varName}=<branch id, as it appears in the connection username> to positively confirm the target.`,
    );
  if (!username.includes(expected.toLowerCase()))
    throw new Error(
      `REFUSING: ${where} does not carry ${varName}=${expected} — wrong target?`,
    );
  console.log(`✓ target confirmed: ${where} (${mode} branch ${expected})`);
}

/** Minimal PoolConfig from PLANETSCALE_DATABASE_URL, mirroring getPoolConfig's ssl-param strip (index.ts). */
export function copyPoolConfig() {
  const url = process.env.PLANETSCALE_DATABASE_URL;
  if (!url) throw new Error("PLANETSCALE_DATABASE_URL unset");
  const u = new URL(url);
  const sslDisabled = ["0", "false", "disable", "disabled"].includes(
    (u.searchParams.get("sslmode") ?? "").toLowerCase(),
  );
  for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"])
    u.searchParams.delete(p);
  return {
    connectionString: u.toString(),
    ssl: sslDisabled ? false : ({ rejectUnauthorized: false } as const),
  };
}
