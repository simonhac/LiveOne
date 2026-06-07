#!/usr/bin/env tsx
/**
 * READ-ONLY config parity check: Turso vs PlanetScale Postgres.
 *
 * Compares every config table row-by-row using the SAME normalization the
 * shadow seam (`lib/db/config-shadow.ts`) applies — so "parity" here means
 * exactly "what the shadow-diff would consider a match". It is traffic-
 * independent: it reads ALL rows from both stores rather than waiting for each
 * read site to be exercised in prod.
 *
 * The per-table projections below are copied faithfully from the (non-exported)
 * `normalize*ForShadow` helpers in systems-manager / polling-utils / point-manager
 * / user-preferences / share-tokens. The shared primitives (toEpochSeconds,
 * normalizeJson, stableStringify) are imported from config-shadow so they can't
 * drift. EXPECTED divergence: `polling_status` churn fields (lastPollTime,
 * lastResponse, totalPolls, successfulPolls, lastSuccessTime, updatedAt) — those
 * are written every poll to Turso while CONFIG_WRITES_TO_PG is off, so PG lags.
 *
 * Reads ONLY. Writes nothing. Run against prod:
 *   NODE_ENV=production npx tsx scripts/parity-config-turso-vs-pg.ts
 * (NODE_ENV=production makes the Turso client use prod liveone-tokyo; PG uses the
 * discrete DB_* fields in .env.local.)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  toEpochSeconds,
  normalizeJson,
  stableStringify,
} from "@/lib/db/config-shadow";

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

// ── Normalizers (copied from the shadow seam; see file header) ───────────────
function normSystem(row: any): unknown {
  return {
    id: row.id,
    status: row.status,
    displayName: row.displayName,
    vendorType: row.vendorType,
    vendorSiteId: row.vendorSiteId,
    ownerClerkUserId: row.ownerClerkUserId ?? null,
    alias: row.alias ?? null,
    model: row.model ?? null,
    serial: row.serial ?? null,
    ratings: row.ratings ?? null,
    solarSize: row.solarSize ?? null,
    batterySize: row.batterySize ?? null,
    timezoneOffsetMin: row.timezoneOffsetMin,
    displayTimezone: row.displayTimezone,
    location: normalizeJson(row.location),
    metadata: normalizeJson(row.metadata),
  };
}

function normPolling(row: any): unknown {
  return {
    systemId: row.systemId,
    lastPollTime: toEpochSeconds(row.lastPollTime),
    lastSuccessTime: toEpochSeconds(row.lastSuccessTime),
    lastErrorTime: toEpochSeconds(row.lastErrorTime),
    lastError: row.lastError ?? null,
    lastResponse: normalizeJson(row.lastResponse),
    consecutiveErrors: row.consecutiveErrors,
    totalPolls: row.totalPolls,
    successfulPolls: row.successfulPolls,
    updatedAt: toEpochSeconds(row.updatedAt),
  };
}

function normPointInfo(row: any): unknown {
  return {
    systemId: row.systemId,
    index: row.index,
    physicalPathTail: row.physicalPathTail,
    logicalPathStem: row.logicalPathStem ?? null,
    metricType: row.metricType,
    metricUnit: row.metricUnit,
    defaultName: row.defaultName,
    displayName: row.displayName,
    subsystem: row.subsystem ?? null,
    transform: row.transform ?? null,
    active: !!row.active,
    createdAt: toEpochSeconds(row.createdAtMs ?? row.createdAt ?? null),
    updatedAt: toEpochSeconds(row.updatedAtMs ?? row.updatedAt ?? null),
  };
}

function normUser(row: any): unknown {
  return {
    clerkUserId: row.clerkUserId,
    defaultSystemId: row.defaultSystemId ?? null,
    createdAt: toEpochSeconds(row.createdAt),
    updatedAt: toEpochSeconds(row.updatedAt),
  };
}

// user_systems has no shadow normalizer (the seam only checks userHasSystemAccess
// as a boolean); compare the membership identity + role.
function normUserSystem(row: any): unknown {
  return {
    clerkUserId: row.clerkUserId,
    systemId: row.systemId,
    role: row.role,
  };
}

function normShareToken(row: any): unknown {
  return {
    token: row.token,
    ownerClerkUserId: row.ownerClerkUserId,
    label: row.label ?? null,
    createdAtMs: row.createdAtMs ?? null,
    expiresAtMs: row.expiresAtMs ?? null,
    revokedAtMs: row.revokedAtMs ?? null,
    lastUsedAtMs: row.lastUsedAtMs ?? null,
  };
}

// ── Comparison ───────────────────────────────────────────────────────────────
function topLevelDiffFields(a: any, b: any): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys]
    .filter((k) => stableStringify(a?.[k]) !== stableStringify(b?.[k]))
    .sort();
}

function truncate(s: string, max = 160): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

interface TableResult {
  name: string;
  tursoCount: number;
  pgCount: number;
  matched: number;
  mismatches: { key: string; fields: string[]; turso: string; pg: string }[];
  onlyTurso: string[];
  onlyPg: string[];
}

function compareTable(
  name: string,
  tursoRows: any[],
  pgRows: any[],
  keyFn: (r: any) => string,
  normFn: (r: any) => unknown,
): TableResult {
  const t = new Map<string, unknown>();
  for (const r of tursoRows) t.set(keyFn(r), normFn(r));
  const p = new Map<string, unknown>();
  for (const r of pgRows) p.set(keyFn(r), normFn(r));

  const keys = new Set<string>([...t.keys(), ...p.keys()]);
  const res: TableResult = {
    name,
    tursoCount: tursoRows.length,
    pgCount: pgRows.length,
    matched: 0,
    mismatches: [],
    onlyTurso: [],
    onlyPg: [],
  };

  for (const k of keys) {
    const hasT = t.has(k);
    const hasP = p.has(k);
    if (hasT && !hasP) {
      res.onlyTurso.push(k);
      continue;
    }
    if (!hasT && hasP) {
      res.onlyPg.push(k);
      continue;
    }
    const ts = stableStringify(t.get(k));
    const ps = stableStringify(p.get(k));
    if (ts === ps) {
      res.matched++;
    } else {
      res.mismatches.push({
        key: k,
        fields: topLevelDiffFields(t.get(k), p.get(k)),
        turso: ts,
        pg: ps,
      });
    }
  }
  return res;
}

function report(r: TableResult, expectChurn = false) {
  const clean =
    r.mismatches.length === 0 &&
    r.onlyTurso.length === 0 &&
    r.onlyPg.length === 0;
  const mark = clean ? "✅" : expectChurn ? "🟡" : "⚠️ ";
  console.log(
    `\n${mark} ${r.name}: turso=${r.tursoCount} pg=${r.pgCount} matched=${r.matched} ` +
      `mismatch=${r.mismatches.length} only-turso=${r.onlyTurso.length} only-pg=${r.onlyPg.length}` +
      (expectChurn && r.mismatches.length
        ? "  (divergence EXPECTED — writes still Turso)"
        : ""),
  );
  if (r.onlyTurso.length)
    console.log(`    only in Turso: ${r.onlyTurso.join(", ")}`);
  if (r.onlyPg.length) console.log(`    only in PG:    ${r.onlyPg.join(", ")}`);
  for (const m of r.mismatches) {
    console.log(`    • key=${m.key} fields=[${m.fields.join(",")}]`);
    console.log(`        turso=${truncate(m.turso)}`);
    console.log(`        pg=   ${truncate(m.pg)}`);
  }
}

async function main() {
  const { db: turso } = await import("@/lib/db/turso");
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  if (!planetscaleDb) {
    console.error(
      "❌ Postgres not configured (DB_* / PLANETSCALE_DATABASE_URL). Aborting.",
    );
    process.exit(1);
  }
  const pg = planetscaleDb;

  const pgHost = process.env.DB_HOST
    ? `${process.env.DB_HOST}:${process.env.DB_PORT ?? 5432}/${process.env.DB_DATABASE ?? ""}`
    : "(PLANETSCALE_DATABASE_URL)";
  const tursoHost = (() => {
    try {
      return new URL(process.env.TURSO_DATABASE_URL || "").host || "(dev.db?)";
    } catch {
      return "(dev.db?)";
    }
  })();

  console.log("═".repeat(72));
  console.log("CONFIG PARITY — Turso vs PlanetScale Postgres  (READ-ONLY)");
  console.log(`  Turso: ${tursoHost}`);
  console.log(`  PG:    ${pgHost}`);
  console.log("═".repeat(72));

  // Read all rows from both stores.
  const [
    tSystems,
    tPolling,
    tPoints,
    tUsers,
    tUserSystems,
    tShareTokens,
    pSystems,
    pPolling,
    pPoints,
    pUsers,
    pUserSystems,
    pShareTokens,
  ] = await Promise.all([
    turso.select().from(tursoSystems),
    turso.select().from(tursoPollingStatus),
    turso.select().from(tursoPointInfo),
    turso.select().from(tursoUsers),
    turso.select().from(tursoUserSystems),
    turso.select().from(tursoShareTokens),
    pg.select().from(pgSystems),
    pg.select().from(pgPollingStatus),
    pg.select().from(pgPointInfo),
    pg.select().from(pgUsers),
    pg.select().from(pgUserSystems),
    pg.select().from(pgShareTokens),
  ]);

  const results = [
    compareTable(
      "systems",
      tSystems,
      pSystems,
      (r) => String(r.id),
      normSystem,
    ),
    compareTable(
      "point_info",
      tPoints,
      pPoints,
      (r) => `${r.systemId}.${r.index}`,
      normPointInfo,
    ),
    compareTable(
      "users",
      tUsers,
      pUsers,
      (r) => String(r.clerkUserId),
      normUser,
    ),
    compareTable(
      "user_systems",
      tUserSystems,
      pUserSystems,
      (r) => `${r.clerkUserId}.${r.systemId}`,
      normUserSystem,
    ),
    compareTable(
      "share_tokens",
      tShareTokens,
      pShareTokens,
      (r) => String(r.token),
      normShareToken,
    ),
  ];

  const polling = compareTable(
    "polling_status",
    tPolling,
    pPolling,
    (r) => String(r.systemId),
    normPolling,
  );

  // Per-table CHURN fields: written on every poll/use, so PG lags while
  // CONFIG_WRITES_TO_PG is off. Divergence confined to these is EXPECTED and
  // self-heals at the write cutover. polling_status churns on success fields for
  // healthy systems AND on error fields (consecutiveErrors/lastError/lastErrorTime)
  // for a system that errors every poll; share_tokens churns on lastUsedAtMs.
  const CHURN: Record<string, Set<string>> = {
    polling_status: new Set([
      "lastPollTime",
      "lastSuccessTime",
      "lastErrorTime",
      "lastResponse",
      "lastError",
      "consecutiveErrors",
      "totalPolls",
      "successfulPolls",
      "updatedAt",
    ]),
    share_tokens: new Set(["lastUsedAtMs"]),
  };

  function isUnexpected(r: TableResult): boolean {
    if (r.onlyTurso.length || r.onlyPg.length) return true;
    const churn = CHURN[r.name];
    return r.mismatches.some((m) =>
      churn ? m.fields.some((f) => !churn.has(f)) : true,
    );
  }

  const all = [...results, polling];
  for (const r of all) report(r, !!CHURN[r.name]);

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(72));
  const bad = all.filter(isUnexpected);
  if (bad.length === 0) {
    console.log(
      "✅ CONFIG IN PARITY — every divergence is a write-churn field that self-heals at CONFIG_WRITES_TO_PG:",
    );
    for (const r of all.filter((r) => r.mismatches.length))
      console.log(
        `   🟡 ${r.name}: ${r.mismatches.length} row(s) diverge ONLY on churn fields.`,
      );
  } else {
    console.log("⚠️  UNEXPECTED divergence — investigate before cutover:");
    for (const r of bad)
      console.log(
        `   • ${r.name}: mismatch=${r.mismatches.length} only-turso=${r.onlyTurso.length} only-pg=${r.onlyPg.length}`,
      );
  }
  console.log("═".repeat(72) + "\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("Parity check failed:", err);
  process.exit(1);
});
