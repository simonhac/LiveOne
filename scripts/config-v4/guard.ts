/**
 * Shared fail-closed target guard + raw-pool config for the config-v4 rehearsal scripts.
 *
 * The branch id lives in the connection USERNAME (pscale_api_<role>.<branchid>) — used for routing, NOT
 * in Postgres current_user (just the role). So the guard keys off the URL, not a DB query. It refuses the
 * prod branch and requires a POSITIVE REHEARSAL_BRANCH_ID match, so a mistyped URL (or the shared
 * liveone-dev) can't be transformed/scanned by accident.
 */

export function assertRehearsalTarget(): void {
  const url = process.env.PLANETSCALE_DATABASE_URL;
  if (!url) throw new Error("PLANETSCALE_DATABASE_URL unset");
  const u = new URL(url);
  const username = decodeURIComponent(u.username).toLowerCase();
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID?.toLowerCase();
  if (prodToken && username.includes(prodToken))
    throw new Error(
      `REFUSING: ${u.username}@${u.host} carries the PROD branch token. This never runs on prod.`,
    );
  const expected = process.env.REHEARSAL_BRANCH_ID?.toLowerCase();
  if (!expected)
    throw new Error(
      "REFUSING: set REHEARSAL_BRANCH_ID=<branch id> (the throwaway snapshot's branch id, as it appears in the connection username) to positively confirm the target.",
    );
  if (!username.includes(expected))
    throw new Error(
      `REFUSING: ${u.username}@${u.host} does not carry REHEARSAL_BRANCH_ID=${expected} — wrong target?`,
    );
  console.log(
    `✓ target confirmed: ${u.username}@${u.host} (rehearsal branch ${expected})`,
  );
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
