#!/usr/bin/env tsx
/**
 * Seed PlanetScale Postgres reference tables from Turso.
 *
 * The observations queue consumer (app/api/observations/receive) writes
 * point_readings / point_readings_agg_5m / sessions, but NOT the slowly-changing
 * reference tables. Without `systems` and `point_info`, the mirrored readings
 * reference systemIds / pointIds that have no metadata. This script copies those
 * reference tables from Turso (the source of truth) into Postgres so the live
 * mirror is queryable.
 *
 * It does NOT copy historical readings/sessions — that backfill is a separate,
 * deferred step.
 *
 * Source/target are chosen from env at runtime:
 *   - Turso: the standard app client (prod Turso when NODE_ENV=production with
 *     TURSO_DATABASE_URL set; otherwise the local dev.db).
 *   - Postgres: PLANETSCALE_DATABASE_URL.
 *
 * Idempotent: upserts systems + point_info + share_tokens + polling_status (and,
 * with --with-users, users + user_systems) on their keys, so re-running refreshes
 * changed metadata — default system, roles, polling counters. Safe to run
 * repeatedly. Aborts (non-zero exit) if any Postgres count ends up below Turso.
 *
 * Usage:
 *   # dry run (default) — reads + reports, writes nothing
 *   npx tsx scripts/seed-planetscale-refs.ts
 *
 *   # actually write to Postgres
 *   npx tsx scripts/seed-planetscale-refs.ts --apply
 *
 *   # also seed users + user_systems (existence only)
 *   npx tsx scripts/seed-planetscale-refs.ts --apply --with-users
 *
 *   # seed PROD Postgres from PROD Turso from a local machine:
 *   NODE_ENV=production npx tsx scripts/seed-planetscale-refs.ts --apply
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import {
  systems as tursoSystems,
  users as tursoUsers,
  userSystems as tursoUserSystems,
  shareTokens as tursoShareTokens,
  pollingStatus as tursoPollingStatus,
} from "@/lib/db/turso/schema";
import { pointInfo as tursoPointInfo } from "@/lib/db/turso/schema-monitoring-points";
import {
  systems as pgSystems,
  pointInfo as pgPointInfo,
  users as pgUsers,
  userSystems as pgUserSystems,
  shareTokens as pgShareTokens,
  pollingStatus as pgPollingStatus,
} from "@/lib/db/planetscale/schema";

/** excluded."<col>" reference for ON CONFLICT DO UPDATE set clauses */
function excluded(col: string) {
  return sql.raw(`excluded."${col}"`);
}

/**
 * Convert an epoch-ms value to a Date, avoiding the 1970 trap: Turso
 * `point_info.created_at_ms` defaults to 0, which would otherwise seed as
 * 1970-01-01. Fall back to a secondary timestamp, then to now.
 */
function msToDate(
  ms: number | null | undefined,
  fallbackMs: number | null | undefined,
): Date {
  if (ms && ms > 0) return new Date(ms);
  if (fallbackMs && fallbackMs > 0) return new Date(fallbackMs);
  return new Date();
}

/** Show only the host of a connection string, never credentials. */
function redactHost(url: string | undefined): string {
  if (!url) return "(not set)";
  try {
    return new URL(url).host || "(configured)";
  } catch {
    return "(configured)";
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const withUsers = args.includes("--with-users");

  // Import DB clients AFTER dotenv so they read the loaded env at construction.
  const { db: turso } = await import("@/lib/db/turso");
  const { planetscaleDb } = await import("@/lib/db/planetscale");

  if (!planetscaleDb) {
    console.error(
      "❌ PLANETSCALE_DATABASE_URL is not set — cannot reach Postgres. Aborting.",
    );
    process.exit(1);
  }

  const tursoHost = redactHost(
    process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL,
  );
  const pgHost = process.env.DB_HOST
    ? `${process.env.DB_HOST}:${process.env.DB_PORT ?? 5432}/${process.env.DB_DATABASE ?? ""}`
    : redactHost(process.env.PLANETSCALE_DATABASE_URL);

  console.log("─".repeat(60));
  console.log("Seed PlanetScale reference tables from Turso");
  console.log(`  Source (Turso):     ${tursoHost}`);
  console.log(`  Target (Postgres):  ${pgHost}`);
  console.log(`  Mode:               ${apply ? "APPLY (writing)" : "DRY RUN"}`);
  console.log(`  Include users:      ${withUsers ? "yes" : "no"}`);
  console.log("─".repeat(60));

  // ---- Read from Turso ----
  const systemRows = await turso.select().from(tursoSystems);
  const pointRows = await turso.select().from(tursoPointInfo);
  const shareTokenRows = await turso.select().from(tursoShareTokens);
  const pollingRows = await turso.select().from(tursoPollingStatus);
  console.log(
    `Read from Turso: ${systemRows.length} systems, ${pointRows.length} point_info rows, ${shareTokenRows.length} share_tokens, ${pollingRows.length} polling_status`,
  );

  let userRows: (typeof tursoUsers.$inferSelect)[] = [];
  let userSystemRows: (typeof tursoUserSystems.$inferSelect)[] = [];
  if (withUsers) {
    userRows = await turso.select().from(tursoUsers);
    userSystemRows = await turso.select().from(tursoUserSystems);
    console.log(
      `Read from Turso: ${userRows.length} users, ${userSystemRows.length} user_systems rows`,
    );
  }

  if (!apply) {
    console.log(
      "\nDRY RUN — no writes performed. Re-run with --apply to seed.",
    );
    return;
  }

  // ---- Seed systems (preserve id) ----
  if (systemRows.length > 0) {
    await planetscaleDb
      .insert(pgSystems)
      .values(
        systemRows.map((s) => ({
          id: s.id,
          ownerClerkUserId: s.ownerClerkUserId,
          vendorType: s.vendorType,
          vendorSiteId: s.vendorSiteId,
          status: s.status,
          displayName: s.displayName,
          alias: s.alias,
          model: s.model,
          serial: s.serial,
          ratings: s.ratings,
          solarSize: s.solarSize,
          batterySize: s.batterySize,
          location: s.location,
          metadata: s.metadata,
          timezoneOffsetMin: s.timezoneOffsetMin,
          displayTimezone: s.displayTimezone,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: pgSystems.id,
        set: {
          ownerClerkUserId: excluded("owner_clerk_user_id"),
          vendorType: excluded("vendor_type"),
          vendorSiteId: excluded("vendor_site_id"),
          status: excluded("status"),
          displayName: excluded("display_name"),
          alias: excluded("alias"),
          model: excluded("model"),
          serial: excluded("serial"),
          ratings: excluded("ratings"),
          solarSize: excluded("solar_size"),
          batterySize: excluded("battery_size"),
          location: excluded("location"),
          metadata: excluded("metadata"),
          timezoneOffsetMin: excluded("timezone_offset_min"),
          displayTimezone: excluded("display_timezone"),
          updatedAt: excluded("updated_at"),
        },
      });

    // Advance the serial sequence past the max preserved id so any future
    // serial-default insert won't collide with a seeded id.
    await planetscaleDb.execute(
      sql`SELECT setval(pg_get_serial_sequence('systems','id'), GREATEST((SELECT MAX(id) FROM systems), 1))`,
    );
    console.log(`✓ Upserted ${systemRows.length} systems (id preserved)`);
  }

  // ---- Seed point_info (composite PK: system_id, id) ----
  if (pointRows.length > 0) {
    await planetscaleDb
      .insert(pgPointInfo)
      .values(
        pointRows.map((p) => ({
          systemId: p.systemId,
          index: p.index,
          physicalPathTail: p.physicalPathTail,
          logicalPathStem: p.logicalPathStem,
          metricType: p.metricType,
          metricUnit: p.metricUnit,
          defaultName: p.defaultName,
          displayName: p.displayName,
          subsystem: p.subsystem,
          transform: p.transform,
          active: p.active,
          createdAt: msToDate(p.createdAtMs, p.updatedAtMs),
          updatedAt: p.updatedAtMs != null ? new Date(p.updatedAtMs) : null,
        })),
      )
      .onConflictDoUpdate({
        target: [pgPointInfo.systemId, pgPointInfo.index],
        set: {
          physicalPathTail: excluded("physical_path_tail"),
          logicalPathStem: excluded("logical_path_stem"),
          metricType: excluded("metric_type"),
          metricUnit: excluded("metric_unit"),
          defaultName: excluded("point_name"),
          displayName: excluded("display_name"),
          subsystem: excluded("subsystem"),
          transform: excluded("transform"),
          active: excluded("active"),
          updatedAt: excluded("updated_at"),
        },
      });
    console.log(`✓ Upserted ${pointRows.length} point_info rows`);
  }

  // ---- Seed share_tokens (PK: token; bigint epoch-ms columns) ----
  if (shareTokenRows.length > 0) {
    await planetscaleDb
      .insert(pgShareTokens)
      .values(
        shareTokenRows.map((t) => ({
          token: t.token,
          ownerClerkUserId: t.ownerClerkUserId,
          label: t.label,
          createdAtMs: t.createdAtMs,
          expiresAtMs: t.expiresAtMs,
          revokedAtMs: t.revokedAtMs,
          lastUsedAtMs: t.lastUsedAtMs,
        })),
      )
      .onConflictDoUpdate({
        target: pgShareTokens.token,
        set: {
          ownerClerkUserId: excluded("owner_clerk_user_id"),
          label: excluded("label"),
          expiresAtMs: excluded("expires_at_ms"),
          revokedAtMs: excluded("revoked_at_ms"),
          lastUsedAtMs: excluded("last_used_at_ms"),
        },
      });
    console.log(`✓ Upserted ${shareTokenRows.length} share_tokens`);
  }

  // ---- Seed polling_status (upsert on unique system_id) ----
  // Turso timestamp/json columns deserialize to Date/object, which the PG
  // timestamp/jsonb columns accept directly. id is left to PG's serial (we
  // upsert on system_id and nothing references polling_status.id).
  if (pollingRows.length > 0) {
    await planetscaleDb
      .insert(pgPollingStatus)
      .values(
        pollingRows.map((p) => ({
          systemId: p.systemId,
          lastPollTime: p.lastPollTime,
          lastSuccessTime: p.lastSuccessTime,
          lastErrorTime: p.lastErrorTime,
          lastError: p.lastError,
          lastResponse: p.lastResponse,
          consecutiveErrors: p.consecutiveErrors,
          totalPolls: p.totalPolls,
          successfulPolls: p.successfulPolls,
          updatedAt: p.updatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: pgPollingStatus.systemId,
        set: {
          lastPollTime: excluded("last_poll_time"),
          lastSuccessTime: excluded("last_success_time"),
          lastErrorTime: excluded("last_error_time"),
          lastError: excluded("last_error"),
          lastResponse: excluded("last_response"),
          consecutiveErrors: excluded("consecutive_errors"),
          totalPolls: excluded("total_polls"),
          successfulPolls: excluded("successful_polls"),
          updatedAt: excluded("updated_at"),
        },
      });
    console.log(`✓ Upserted ${pollingRows.length} polling_status rows`);
  }

  // ---- Optionally seed users + user_systems ----
  if (withUsers) {
    if (userRows.length > 0) {
      await planetscaleDb
        .insert(pgUsers)
        .values(
          userRows.map((u) => ({
            clerkUserId: u.clerkUserId,
            defaultSystemId: u.defaultSystemId,
            createdAt: u.createdAt,
            updatedAt: u.updatedAt,
          })),
        )
        .onConflictDoUpdate({
          target: pgUsers.clerkUserId,
          set: {
            defaultSystemId: excluded("default_system_id"),
            updatedAt: excluded("updated_at"),
          },
        });
      console.log(`✓ Upserted ${userRows.length} users`);
    }

    if (userSystemRows.length > 0) {
      await planetscaleDb
        .insert(pgUserSystems)
        .values(
          userSystemRows.map((us) => ({
            id: us.id,
            clerkUserId: us.clerkUserId,
            systemId: us.systemId,
            role: us.role,
            createdAt: us.createdAt,
            updatedAt: us.updatedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [pgUserSystems.clerkUserId, pgUserSystems.systemId],
          set: {
            role: excluded("role"),
            updatedAt: excluded("updated_at"),
          },
        });
      await planetscaleDb.execute(
        sql`SELECT setval(pg_get_serial_sequence('user_systems','id'), GREATEST((SELECT MAX(id) FROM user_systems), 1))`,
      );
      console.log(`✓ Upserted ${userSystemRows.length} user_systems`);
    }
  }

  // ---- Verify (hard-abort on any shortfall) ----
  const pgSystemCount = (await planetscaleDb.select().from(pgSystems)).length;
  const pgPointCount = (await planetscaleDb.select().from(pgPointInfo)).length;
  const pgShareTokenCount = (await planetscaleDb.select().from(pgShareTokens))
    .length;
  const pgPollingCount = (await planetscaleDb.select().from(pgPollingStatus))
    .length;
  console.log("─".repeat(60));
  console.log(
    `Postgres now has: ${pgSystemCount} systems, ${pgPointCount} point_info, ${pgShareTokenCount} share_tokens, ${pgPollingCount} polling_status`,
  );

  const shortfalls: string[] = [];
  if (pgSystemCount < systemRows.length)
    shortfalls.push(`systems ${pgSystemCount}<${systemRows.length}`);
  if (pgPointCount < pointRows.length)
    shortfalls.push(`point_info ${pgPointCount}<${pointRows.length}`);
  if (pgShareTokenCount < shareTokenRows.length)
    shortfalls.push(
      `share_tokens ${pgShareTokenCount}<${shareTokenRows.length}`,
    );
  if (pgPollingCount < pollingRows.length)
    shortfalls.push(`polling_status ${pgPollingCount}<${pollingRows.length}`);
  if (withUsers) {
    const pgUserCount = (await planetscaleDb.select().from(pgUsers)).length;
    const pgUserSystemCount = (await planetscaleDb.select().from(pgUserSystems))
      .length;
    console.log(`  + ${pgUserCount} users, ${pgUserSystemCount} user_systems`);
    if (pgUserCount < userRows.length)
      shortfalls.push(`users ${pgUserCount}<${userRows.length}`);
    if (pgUserSystemCount < userSystemRows.length)
      shortfalls.push(
        `user_systems ${pgUserSystemCount}<${userSystemRows.length}`,
      );
  }

  if (shortfalls.length > 0) {
    throw new Error(
      `Postgres row counts below Turso source — aborting: ${shortfalls.join(", ")}`,
    );
  }
  console.log("✓ Reference tables seeded.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
