/**
 * Re-own dev-mirror data from a PROD clerk id to a DEV clerk id, so your dev login sees the same
 * areas / dashboards / systems as prod — AND grant the prod id read-back access to what it just lost,
 * so Vercel preview (which deliberately signs in with the LIVE prod Clerk session — see the
 * bind-preview skill — not this separate dev instance's id) can still see the same mirrored data.
 *
 * Dev + Vercel preview use a SEPARATE Clerk instance, so "you" has a different `clerk_user_id` there
 * than on prod. The prod→dev sync (sync-prod-to-dev-db.ts) copies config data carrying the PROD owner
 * ids, so on `liveone-dev` your data is owned by your prod id while you log in with your dev id — you
 * can open things by URL (admin) but they aren't "yours" (menu / ownership / default dashboard). This
 * remaps the ownership columns prod→dev so dev-you genuinely owns the mirrored data — and then GRANTS
 * (viewer role, `user_systems` / `dashboard_grants`, purely additive) the prod id back onto everything
 * it just lost ownership of, so a prod-Clerk-authenticated session (preview) still resolves it via
 * `getSystemsVisibleByUser`/`listAccessibleDashboards`'s existing owned-OR-granted logic. Idempotent
 * (ON CONFLICT DO NOTHING) and never revokes/deletes a grant, matching the sync's own "full refresh,
 * upsert, no deletes" convention for small config tables.
 *
 * Configured by DEV_OWNER_REMAP = comma-separated `prodId:devId` pairs. If unset it's a no-op (exit 0),
 * so it can sit as a leg of the sync until you configure the mapping.
 *
 * DEV-ONLY: refuses if the write target carries PLANETSCALE_PROD_BRANCH_ID. Idempotent.
 *
 *   # one-off (local):
 *   DEV_OWNER_REMAP="user_PROD:user_DEV" npx tsx --env-file=.env.local scripts/utils/reown-dev-data.ts
 *   # in the sync workflow:
 *   npm run db:reown-dev   # env (LIVEONE_DEV_DATABASE_URL, DEV_OWNER_REMAP, PLANETSCALE_PROD_BRANCH_ID) from secrets
 */
import { Client } from "pg";

// Every clerk-id-keyed OWNERSHIP column. `users.clerk_user_id` is the PRIMARY KEY — handled separately
// below (copy prefs, don't rename) to avoid a collision when both the prod and dev user rows exist.
//
// GRANT tables (`user_systems`, `dashboard_grants`) are deliberately NOT here. They are access grants
// with a COMPOSITE UNIQUE key — `(clerk_user_id, system_id)` / `(dashboard_id, clerk_user_id)` — not
// ownership. Two reasons they must stay out of the ownership remap:
//   1. Redundant: dev-you already sees the data by OWNING it (the systems/dashboards/areas owner
//      columns below remap to the dev id); an extra grant for the dev id buys nothing.
//   2. Harmful: `UPDATE ... SET clerk_user_id = <dev>` collides with the row a previous run's
//      grant-back already created for that (user, system/dashboard) pair → a duplicate-key abort
//      (`user_system_unique` / `dashboard_grants_dashboard_user_unique`) that failed the sync every
//      steady-state run, drifting `liveone-dev`.
// The PROD id's read-back access is handled purely additively by the ON CONFLICT DO NOTHING
// grant-back below — which is the ONLY thing that should touch these two tables.
const OWNERSHIP: ReadonlyArray<{ table: string; col: string; where?: string }> =
  [
    { table: "systems", col: "owner_clerk_user_id" },
    { table: "share_tokens", col: "owner_clerk_user_id" },
    // Legacy per-system dashboards (and their `system_id` column) were dropped in the P6 demolition
    // (migration 0022) — every remaining row is a composition/v3 dashboard, so no filter is needed.
    { table: "dashboards", col: "clerk_user_id" },
    { table: "areas", col: "owner_clerk_user_id" },
  ];

function parseRemap(raw: string): Array<[from: string, to: string]> {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [from, to] = pair.split(":").map((s) => s.trim());
      if (!from || !to)
        throw new Error(
          `bad DEV_OWNER_REMAP pair: "${pair}" (want prodId:devId)`,
        );
      return [from, to] as [string, string];
    });
}

function devClient(url: string): Client {
  const u = new URL(url);
  // Fail-closed: never let this run against prod (it carries the prod branch id in its username).
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID;
  const ident = `${decodeURIComponent(u.username)}@${u.hostname}`;
  if (prodToken && ident.includes(prodToken)) {
    throw new Error(
      `REFUSING: write target carries the prod branch id (${prodToken}) — reown-dev writes to DEV only`,
    );
  }
  return new Client({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "") || "postgres",
    ssl: { rejectUnauthorized: false },
  });
}

async function main() {
  const remapRaw = process.env.DEV_OWNER_REMAP;
  if (!remapRaw || !remapRaw.trim()) {
    console.log("DEV_OWNER_REMAP not set — nothing to remap (skipping).");
    return;
  }
  const url =
    process.env.LIVEONE_DEV_DATABASE_URL ||
    process.env.PLANETSCALE_DATABASE_URL;
  if (!url)
    throw new Error(
      "No dev DB URL (set LIVEONE_DEV_DATABASE_URL or PLANETSCALE_DATABASE_URL)",
    );

  const pairs = parseRemap(remapRaw);
  const c = devClient(url);
  await c.connect();
  let hadError = false;
  try {
    for (const [from, to] of pairs) {
      console.log(`remap ${from} -> ${to}`);
      let total = 0;
      for (const { table, col, where } of OWNERSHIP) {
        // Isolated per table: one bad/stale clause (e.g. a column a later migration dropped) must not
        // silently skip every table after it in the list — log and move on instead of aborting.
        try {
          const r = await c.query(
            `UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2${where ? ` AND ${where}` : ""}`,
            [to, from],
          );
          if (r.rowCount) console.log(`  ${table}.${col}: ${r.rowCount}`);
          total += r.rowCount ?? 0;
        } catch (e) {
          hadError = true;
          console.error(
            `  ERR ${table}.${col}: ${e instanceof Error ? e.message : e}`,
          );
        }
      }

      // Grant the PROD id (`from`) read-back access to what it just lost ownership of, above. Purely
      // additive viewer-role grants — doesn't touch the ownership columns, so the local-dev "it's
      // mine" experience (menu/default dashboard) is unaffected. Selects by current ownership (`to`)
      // rather than "just remapped by this run", so it also backfills anything remapped by an EARLIER
      // run (before this grant-back existed) or by a prior sync cycle.
      try {
        const sysGrant = await c.query(
          `INSERT INTO user_systems (clerk_user_id, system_id, role)
             SELECT $1, id, 'viewer' FROM systems WHERE owner_clerk_user_id = $2
             ON CONFLICT (clerk_user_id, system_id) DO NOTHING`,
          [from, to],
        );
        if (sysGrant.rowCount)
          console.log(
            `  user_systems: granted ${from} -> ${sysGrant.rowCount} systems`,
          );
      } catch (e) {
        hadError = true;
        console.error(
          `  ERR user_systems grant-back: ${e instanceof Error ? e.message : e}`,
        );
      }
      try {
        const dashGrant = await c.query(
          `INSERT INTO dashboard_grants (dashboard_id, clerk_user_id, role, created_at_ms)
             SELECT id, $1, 'viewer', (extract(epoch from now()) * 1000)::bigint
               FROM dashboards WHERE clerk_user_id = $2
             ON CONFLICT (dashboard_id, clerk_user_id) DO NOTHING`,
          [from, to],
        );
        if (dashGrant.rowCount)
          console.log(
            `  dashboard_grants: granted ${from} -> ${dashGrant.rowCount} dashboards`,
          );
      } catch (e) {
        hadError = true;
        console.error(
          `  ERR dashboard_grants grant-back: ${e instanceof Error ? e.message : e}`,
        );
      }

      // users.clerk_user_id is the PK: if the dev user row already exists, copy the prod row's prefs
      // into it (renaming the PK would collide); otherwise rename the prod row to the dev id.
      const devRowExists =
        ((await c.query("SELECT 1 FROM users WHERE clerk_user_id = $1", [to]))
          .rowCount ?? 0) > 0;
      if (devRowExists) {
        const up = await c.query(
          // `default_system_id` was dropped in P6 (migration 0022) — the landing default is now
          // the dashboard. Referencing the dead column here silently failed every sync run (the
          // step was continue-on-error) until this was fixed + the mask removed in the workflow.
          `UPDATE users u
              SET default_dashboard_id = f.default_dashboard_id,
                  updated_at           = now()
             FROM users f
            WHERE u.clerk_user_id = $1 AND f.clerk_user_id = $2`,
          [to, from],
        );
        if (up.rowCount) console.log(`  users: copied prefs ${from} -> ${to}`);
      } else {
        const ren = await c.query(
          "UPDATE users SET clerk_user_id = $1 WHERE clerk_user_id = $2",
          [to, from],
        );
        if (ren.rowCount) console.log(`  users: renamed ${from} -> ${to}`);
      }
      console.log(`  ownership rows updated: ${total}`);
    }
  } finally {
    await c.end();
  }
  // A per-table failure is logged and skipped (see above) so the rest of the list still runs, but
  // it must still fail the run overall — otherwise a stale clause (like the one this fixed) can
  // silently stop remapping a table forever with no signal anywhere.
  if (hadError)
    throw new Error(
      "one or more ownership updates failed — see ERR lines above",
    );
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
