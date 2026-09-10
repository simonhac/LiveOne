#!/usr/bin/env tsx
/**
 * pg-migrate — apply pending Postgres migrations to a PlanetScale branch WITHOUT leaving objects
 * owned by a temporary role.
 *
 * ## The trap this exists to close
 *
 * Prod (`sydney`) has no stored connection string, so applying a migration there means minting a
 * short-TTL `pscale role`. Postgres makes the CREATING role the OWNER of everything it creates —
 * `--inherited-roles postgres` grants the privileges to create, it does not make `postgres` the
 * owner of the result. So a migration applied that way leaves its new tables, indexes and sequences
 * owned by a role that is about to be deleted. Two things then go wrong, both LATER and both quiet:
 *
 *   1. The app connects as `postgres` and gets "permission denied" on the new table — not at apply
 *      time, but whenever the dependent code finally ships. The migration reported success.
 *   2. `pscale role delete` REFUSES while the role owns objects, so the role lingers, and its TTL
 *      delete fails the same way every time, forever.
 *
 * The remedy is one command — `pscale role reassign … --successor postgres` — and the entire
 * problem is that it is a SEPARATE STEP, after a migration that has already said "success". Here it
 * is a `finally`: it runs whether the migration passed, failed, was refused by a guard, or the
 * process was interrupted.
 *
 * 🛑 **Never reach for `pscale role reset-default` to get around this.** It is the other documented
 * route to `postgres` credentials and on prod it is an OUTAGE: it ROTATES the password, so every
 * connection using `postgres` breaks — and Vercel captures env at BUILD time, so recovery needs the
 * env updated AND a redeploy. Minting a temp role costs nothing and breaks nothing.
 *
 * ## What it does NOT do
 *
 * It does not check that the migration was CORRECT. Gates belong in the migration file, where they
 * run inside the migrator's transaction and roll the whole thing back (`docs/migrations.md`). This
 * tool guarantees exactly one thing beyond `drizzle-kit migrate`: that nothing is left owned by a
 * role that is about to vanish.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import { defineCommand, run, failWith, EXIT, type Ctx } from "@/lib/cli/cli";

const exec = promisify(execFile);

/**
 * The ownership sweep. `public` is the only schema a migration writes into; `drizzle` holds the
 * journal and is created once. Indexes and sequences are included deliberately — one CREATE TABLE
 * with a PK and a serial creates all three, and each is owned independently, so a sweep that looked
 * only at tables would call a half-reassigned branch clean.
 *
 * `relkind` is `"char"`, and `"char" || text` is AMBIGUOUS in Postgres ("could not choose a best
 * candidate operator"). Cast it. Migration 0055 learned the same lesson about `pg_depend.deptype`.
 */
const OWNERSHIP_SQL = `
  SELECT c.relkind::text AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relkind IN ('r','p','i','S','v','m')
    AND pg_get_userbyid(c.relowner) <> 'postgres'
  UNION ALL
  SELECT 'f', p.proname, pg_get_userbyid(p.proowner)
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND pg_get_userbyid(p.proowner) <> 'postgres'
  ORDER BY 1, 2
`;

interface OwnedObject {
  kind: string;
  name: string;
  owner: string;
}

interface MintedRole {
  id: string;
  username: string;
  host: string;
  url: string;
}

/**
 * node-pg's connection-string parser chokes on PlanetScale's `sslmode=verify-full` (libpq resolves
 * it against the system trust store; pg treats it as a file path). Decompose and set ssl explicitly
 * — the same thing `drizzle-planetscale.config.ts` and `getPoolConfig` both do.
 */
async function query<T>(url: string, sql: string): Promise<T[]> {
  const u = new URL(url);
  const client = new Client({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "") || "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const res = await client.query(sql);
    return res.rows as T[];
  } finally {
    await client.end();
  }
}

async function pscale(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("pscale", args, {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw failWith(
      EXIT.UPSTREAM,
      `pscale ${args[0]} ${args[1] ?? ""} failed`,
      detail.split("\n")[0],
      "check `pscale auth login` and that the database/branch names are right",
    );
  }
}

/**
 * Least privilege: an audit only reads the catalogue, so it mints a read-only role. A read-only
 * role also cannot own anything, so the trap cannot apply to it in the first place.
 */
async function mintRole(
  database: string,
  branch: string,
  ttl: string,
  readOnly: boolean,
): Promise<MintedRole> {
  const name = `m${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  const out = await pscale([
    "role",
    "create",
    database,
    branch,
    name,
    "--inherited-roles",
    readOnly ? "pg_read_all_data" : "postgres",
    "--ttl",
    ttl,
    "--format",
    "json",
  ]);
  const r = JSON.parse(out) as {
    id: string;
    username: string;
    access_host_url: string;
    database_url: string;
  };
  return {
    id: r.id,
    username: r.username,
    host: r.access_host_url,
    url: r.database_url,
  };
}

/**
 * 🛑 THE POINT OF THIS FILE. Reassign, then delete — in that order, always, on every exit path.
 *
 * `reassign` is a no-op when the role owns nothing, so it is free to run unconditionally; `delete`
 * is the step that would otherwise fail. Neither is allowed to throw: this runs in a `finally`, and
 * masking the real error with a cleanup error would hide why the migration failed.
 */
async function releaseRole(
  ctx: Ctx,
  database: string,
  branch: string,
  role: MintedRole,
): Promise<void> {
  try {
    await pscale([
      "role",
      "reassign",
      database,
      branch,
      role.id,
      "--successor",
      "postgres",
      "--force",
    ]);
  } catch {
    ctx.warn(
      `reassign FAILED for ${role.id} — run this BEFORE the role expires, or its objects become ` +
        `unreachable to the app:\n` +
        `  pscale role reassign ${database} ${branch} ${role.id} --successor postgres --force`,
    );
  }
  try {
    await pscale(["role", "delete", database, branch, role.id, "--force"]);
  } catch {
    ctx.warn(
      `role ${role.id} could NOT be deleted — it still owns objects. That IS the trap: sweep with ` +
        `--audit, reassign by hand, then delete.`,
    );
  }
}

/**
 * What is pending — decided the way DRIZZLE decides it, which is by TIMESTAMP, not by hash. Its pg
 * dialect reads only the single latest applied `created_at` and runs every journal entry whose
 * `when` exceeds it (`drizzle-orm/pg-core/dialect.js`). The recorded hash is never compared.
 *
 * 🛑 Two consequences, both of which have bitten this repo:
 *   • A migration whose `when` is BELOW the high-water mark is silently SKIPPED, and `migrate`
 *     still reports success — the "journal drift" failure where nothing changes and nothing says
 *     so. Renumbering or backdating a migration is what produces it.
 *   • An already-applied file that has since been EDITED is invisible here, because drizzle never
 *     re-reads the hash it stored. Do not edit an applied migration.
 */
function pendingTags(lastAppliedMs: number): string[] {
  const dir = path.join(process.cwd(), "drizzle-planetscale");
  const journal = JSON.parse(
    fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  return journal.entries
    .filter((e) => Number(e.when) > lastAppliedMs)
    .map((e) => e.tag);
}

export const cmd = defineCommand({
  name: "pg-migrate",
  summary:
    "Apply pending Postgres migrations to a PlanetScale branch, leaving nothing owned by a temp role.",
  when:
    "Use this for EVERY migration applied to prod `sydney`, in place of `npm run db:pg:migrate`.\n" +
    "Prod has no stored connection string, so applying there means minting a role — and Postgres\n" +
    "makes that role the OWNER of what it creates, which the app (connecting as `postgres`) then\n" +
    "cannot read. Also reach for it with --audit when a `pscale role delete` refuses, or when a\n" +
    "table that exists returns 'permission denied'.\n" +
    "For liveone-dev use plain `npm run db:pg:migrate`: .env.local already points at the\n" +
    "persistent `postgres` role, so nothing is minted and the trap cannot arise.",
  description:
    "Reports the target (with the branch id read from the CONNECTION USERNAME, the only place it\n" +
    "is legible), the pending migrations, and any object in `public` not owned by `postgres`.\n" +
    "With --apply it applies, reassigns ownership to `postgres`, and re-sweeps to prove it.\n" +
    "The reassign+delete runs in a `finally`, so an interrupted or failed run still cleans up.\n" +
    "🛑 It does NOT check that the migration was correct — gates belong in the migration file,\n" +
    "inside the migrator's transaction. This guarantees ownership, and nothing else.",
  flags: {
    database: {
      type: "string",
      default: "liveone",
      placeholder: "name",
      help: "PlanetScale database",
    },
    branch: {
      type: "string",
      default: "sydney",
      placeholder: "name",
      help: "Branch to apply to (prod is `sydney`)",
    },
    "role-ttl": {
      type: "string",
      default: "1h",
      placeholder: "duration",
      help: "TTL for the minted role",
    },
    audit: {
      type: "boolean",
      help: "Ownership sweep only — mints a READ-ONLY role and applies nothing",
    },
  },
  mutates: true,
  uses: ["db"],
  exitCodes: {
    1: "ownership debt found, or migrations are pending in a dry run",
  },
  examples: [
    "npm run db:pg:migrate:prod",
    "npm run db:pg:migrate:prod -- --apply",
    "npm run db:pg:migrate:prod -- --audit",
    "npm run db:pg:migrate:prod -- --branch restore-drill --audit",
  ],
});

async function main(ctx: Ctx): Promise<number> {
  const database = ctx.flags.database as string;
  const branch = ctx.flags.branch as string;
  const ttl = ctx.flags["role-ttl"] as string;
  const audit = ctx.flags.audit === true;

  // The guard's reference value. Refuse without it rather than guess: the banner below would then
  // be asserting "PRODUCTION" or "non-prod" on no evidence, which is worse than not printing it.
  const prodBranchId = process.env.PLANETSCALE_PROD_BRANCH_ID;
  if (!prodBranchId) {
    throw failWith(
      EXIT.USAGE,
      "PLANETSCALE_PROD_BRANCH_ID is not set",
      "without it this tool cannot tell prod from dev, and the target banner would be a guess",
      "run via `npm run db:pg:migrate:prod` (which passes --env-file=.env.local)",
    );
  }

  const role = await mintRole(database, branch, ttl, audit);
  try {
    // 🛑 The guard reads the CONNECTION USERNAME. PlanetScale puts every branch in a region on ONE
    // gateway host and tells them apart by the username suffix (`postgres.<branch-id>`), so the
    // hostname proves nothing. And inside Postgres `current_user` has that suffix STRIPPED — so a
    // server-side `current_user LIKE '%<id>%'` check FALSE-NEGATIVES. The URL is the only place the
    // branch id can be read. Same rule as the app's `assertDbEnvironmentMatches`.
    const isProd = role.username.includes(prodBranchId);

    ctx.note(
      [
        "",
        `  target:   ${database}/${branch}   ${isProd ? "🛑 PRODUCTION" : "(non-prod)"}`,
        `  user:     ${role.username}`,
        `  host:     ${role.host}`,
        `  role:     ${role.id} (${audit ? "read-only" : "ddl"}, ttl ${ttl}, released on exit)`,
        "",
      ].join("\n"),
    );

    // Both directions, mirroring the app's guard: fail CLOSED when a branch that should not be prod
    // carries the prod id, and refuse just as hard when a branch that should be prod does not.
    if (isProd && branch !== "sydney") {
      throw failWith(
        EXIT.AUTH,
        `branch "${branch}" carries the PRODUCTION branch id`,
        "this connection reaches prod under another name",
        "check the branch name, or PLANETSCALE_PROD_BRANCH_ID if it is stale",
      );
    }
    if (!isProd && branch === "sydney") {
      throw failWith(
        EXIT.AUTH,
        'asked for "sydney" but the connection does not carry the prod branch id',
        "either PLANETSCALE_PROD_BRANCH_ID is stale or this is not the branch you think",
        "confirm with `pscale branch list " + database + "`",
      );
    }

    const owned = await query<OwnedObject>(role.url, OWNERSHIP_SQL);

    if (audit) {
      ctx.emit({ target: { database, branch, isProd }, owned }, (m: never) => {
        const model = m as { owned: OwnedObject[] };
        if (!model.owned.length)
          return "✓ ownership clean — every object in public is owned by postgres.";
        return [
          "Objects NOT owned by postgres — the app connects as postgres and will get",
          "'permission denied' on each of these:",
          ...model.owned.map((o) => `  ${o.kind} ${o.name} -> ${o.owner}`),
          "",
          `${model.owned.length} object(s). Fix: pscale role reassign ${database} ${branch} <role-id> --successor postgres --force`,
        ].join("\n");
      });
      return owned.length ? EXIT.FINDINGS : EXIT.OK;
    }

    const [{ last }] = await query<{ last: string }>(
      role.url,
      "SELECT COALESCE(max(created_at), 0)::text AS last FROM drizzle.__drizzle_migrations",
    );
    const pending = pendingTags(Number(last));

    // Dry run is the DEFAULT (`mutates: true`), and it is honoured here rather than only at a
    // confirmation prompt — the trap the harness warns about is a dry run that reports and then
    // does it anyway.
    if (ctx.dryRun || pending.length === 0) {
      ctx.emit(
        {
          target: { database, branch, isProd },
          pending,
          owned,
          applied: false,
        },
        (m: never) => {
          const model = m as {
            pending: string[];
            owned: OwnedObject[];
            target: { branch: string };
          };
          const out: string[] = [];
          if (model.owned.length) {
            out.push(
              "⚠️  PRE-EXISTING ownership debt:",
              ...model.owned.map((o) => `  ${o.kind} ${o.name} -> ${o.owner}`),
              "",
            );
          }
          if (!model.pending.length) {
            out.push(`Nothing pending on ${model.target.branch} — up to date.`);
          } else {
            out.push(
              `Pending on ${model.target.branch}:`,
              ...model.pending.map((t) => `  ${t}`),
              "",
              "Re-run with --apply to apply the above.",
            );
          }
          return out.join("\n");
        },
      );
      return pending.length || owned.length ? EXIT.FINDINGS : EXIT.OK;
    }

    if (
      isProd &&
      !(await ctx.confirm(
        `Apply ${pending.length} migration(s) to 🛑 PRODUCTION (${database}/${branch})?`,
      ))
    ) {
      ctx.note("aborted.");
      return EXIT.OK;
    }

    // drizzle-kit runs each migration file in ONE transaction, so a failed gate rolls the whole
    // file back and records nothing — which is what makes the cleanup safe on the failure path too.
    ctx.note(`applying ${pending.length} migration(s)…`);
    try {
      await exec(
        "npx",
        ["drizzle-kit", "migrate", "--config=drizzle-planetscale.config.ts"],
        {
          env: {
            ...process.env,
            PLANETSCALE_DATABASE_URL_MIGRATIONS: role.url,
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw failWith(
        EXIT.UPSTREAM,
        "drizzle-kit migrate failed",
        detail.split("\n").slice(0, 6).join("\n"),
        "the file runs in one transaction, so nothing was recorded — fix and re-run",
      );
    }

    // 🛑 Reassign HERE as well as in the `finally`. The finally has not run yet, so without this the
    // sweep below would report every object this run just created as debt — and a tool that cries
    // wolf on its own successful output is a tool people stop reading.
    await pscale([
      "role",
      "reassign",
      database,
      branch,
      role.id,
      "--successor",
      "postgres",
      "--force",
    ]);

    // Verify the CATALOGUE, not the migrator's word for it: a migration that silently did nothing
    // looks exactly like one that worked.
    const after = await query<OwnedObject>(role.url, OWNERSHIP_SQL);
    const [{ tag }] = await query<{ tag: string }>(
      role.url,
      "SELECT max(id)::text || ' ' || (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1) AS tag FROM drizzle.__drizzle_migrations",
    );

    ctx.emit(
      {
        target: { database, branch, isProd },
        applied: pending,
        owned: after,
        journal: tag,
      },
      (m: never) => {
        const model = m as {
          applied: string[];
          owned: OwnedObject[];
          journal: string;
        };
        if (model.owned.length)
          return [
            "⚠️  objects are STILL not owned by postgres after the reassign:",
            ...model.owned.map((o) => `  ${o.kind} ${o.name} -> ${o.owner}`),
          ].join("\n");
        return [
          `✓ applied: ${model.applied.join(", ")}`,
          "✓ every object in public is owned by postgres.",
          `  journal now at: ${model.journal}`,
          "  🛑 now verify the SHAPE you expected actually landed — the catalogue, by name.",
        ].join("\n");
      },
    );
    return after.length ? EXIT.FINDINGS : EXIT.OK;
  } finally {
    // The guarantee. Runs on success, on a thrown guard, on a failed migration, on SIGINT.
    await releaseRole(ctx, database, branch, role);
  }
}

run(cmd, main, import.meta.url);
