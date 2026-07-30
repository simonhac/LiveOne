/**
 * Per-dashboard sharing (P4): dashboard-scoped share tokens + grant lookups.
 *
 * A share token is a read-only public link scoped to ONE dashboard. A holder gets read access to
 * exactly the points that dashboard exposes (lib/dashboard/access.ts), resolved at consumption time —
 * never general device access. Reuses the 3-word phrase generator from lib/share-tokens.ts.
 *
 * config-v4: the two token tables are UNIFIED onto `share_tokens` (dashboard_id uuid NOT NULL, naive-UTC
 * `timestamp` columns; the legacy owner-scoped `share_tokens` rows were re-pointed at auto-created
 * dashboards at cutover). The retired `dashboard_share_tokens` table survives (dead) until Phase 9.
 */
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { shareTokens } from "@/lib/db/planetscale/schema";
import { generateTokenString, isWellFormedToken } from "@/lib/share-tokens";
import { Dashboard } from "@/lib/ids";

// config-v4: this module's public surface speaks the opaque `db_…` dashboard id; the raw uuid
// (share_tokens.dashboard_id) is decoded on the way into SQL and encoded on the way out.

export interface CreateDashboardShareTokenOptions {
  dashboardId: string; // opaque `db_…` dashboard id
  expiresInDays?: number | null; // null/undefined => never expires
  label: string; // required, human-readable name for the link
}

export async function createDashboardShareToken(
  opts: CreateDashboardShareTokenOptions,
): Promise<{ token: string; expiresAtMs: number | null }> {
  const dashboardUuid = Dashboard.toUuidOrNull(opts.dashboardId);
  if (!dashboardUuid) throw new Error("invalid dashboard id");
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateTokenString();
    const expiresAtMs =
      opts.expiresInDays && opts.expiresInDays > 0
        ? Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000
        : null;
    try {
      await requirePlanetscaleDb()
        .insert(shareTokens)
        .values({
          token,
          dashboardId: dashboardUuid,
          label: opts.label,
          createdAt: new Date(),
          expiresAt: expiresAtMs != null ? new Date(expiresAtMs) : null,
        });
      return { token, expiresAtMs };
    } catch (err: unknown) {
      // Token PK collision → SQLSTATE 23505 (unique_violation); retry with a fresh phrase.
      if ((err as { code?: string })?.code === "23505") continue;
      throw err;
    }
  }
  throw new Error("failed to allocate unique dashboard share token");
}

export interface ValidatedDashboardToken {
  token: string;
  dashboardId: string; // opaque `db_…` dashboard id
}

/** Wire shape returned to the share-settings panel (epoch-ms, mirroring `ShareTokenRow` there). */
export interface ShareTokenListRow {
  token: string;
  label: string | null;
  createdAtMs: number | null;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
}

/** Validate a token (well-formed, not revoked, not expired) → its dashboard, touching last_used. */
export async function validateDashboardShareToken(
  token: string,
): Promise<ValidatedDashboardToken | null> {
  if (!isWellFormedToken(token)) return null;
  const now = new Date();
  const pg = requirePlanetscaleDb();
  const rows = await pg
    .select()
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.token, token),
        isNull(shareTokens.revokedAt),
        or(isNull(shareTokens.expiresAt), gt(shareTokens.expiresAt, now)),
      ),
    )
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;

  void pg
    .update(shareTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(shareTokens.token, token))
    .catch(() => {});

  return { token: row.token, dashboardId: Dashboard.encode(row.dashboardId) };
}

/**
 * List a dashboard's share tokens for the settings panel.
 *
 * Projects EXPLICITLY and maps the `timestamp` columns to epoch-ms. It used to be a bare
 * `.select()`, which passed every column through to the client — including the legacy `*_ms` bigints
 * that `createDashboardShareToken` has never written. Those were therefore always NULL, so the panel
 * showed every token as "Never expires", never showed last-used, and — because it filters on
 * `revokedAtMs == null` — listed REVOKED tokens as active. (Auth was never affected:
 * `validateDashboardShareToken` reads the `timestamp` columns.) Migration 0037 drops the `*_ms`
 * columns; this projection is what decouples the UI from them.
 */
export async function listDashboardShareTokens(
  dashboardId: string,
): Promise<ShareTokenListRow[]> {
  const uuid = Dashboard.toUuidOrNull(dashboardId);
  if (!uuid) return [];
  const rows = await requirePlanetscaleDb()
    .select({
      token: shareTokens.token,
      label: shareTokens.label,
      createdAt: shareTokens.createdAt,
      expiresAt: shareTokens.expiresAt,
      revokedAt: shareTokens.revokedAt,
      lastUsedAt: shareTokens.lastUsedAt,
    })
    .from(shareTokens)
    .where(eq(shareTokens.dashboardId, uuid))
    .orderBy(desc(shareTokens.createdAt));
  return rows.map((r) => ({
    token: r.token,
    label: r.label,
    createdAtMs: r.createdAt?.getTime() ?? null,
    expiresAtMs: r.expiresAt?.getTime() ?? null,
    revokedAtMs: r.revokedAt?.getTime() ?? null,
    lastUsedAtMs: r.lastUsedAt?.getTime() ?? null,
  }));
}

/** Revoke a token, scoped to its dashboard (the route verifies the caller owns that dashboard). */
export async function revokeDashboardShareToken(
  token: string,
  dashboardId: string,
): Promise<boolean> {
  const uuid = Dashboard.toUuidOrNull(dashboardId);
  if (!uuid) return false;
  const result = await requirePlanetscaleDb()
    .update(shareTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(shareTokens.token, token),
        eq(shareTokens.dashboardId, uuid),
        isNull(shareTokens.revokedAt),
      ),
    )
    .returning();
  return result.length > 0;
}

/** Rename a (non-revoked) token's label, scoped to its dashboard. Returns true if a row updated. */
export async function renameDashboardShareToken(
  token: string,
  dashboardId: string,
  label: string,
): Promise<boolean> {
  const uuid = Dashboard.toUuidOrNull(dashboardId);
  if (!uuid) return false;
  const result = await requirePlanetscaleDb()
    .update(shareTokens)
    .set({ label })
    .where(
      and(
        eq(shareTokens.token, token),
        eq(shareTokens.dashboardId, uuid),
        isNull(shareTokens.revokedAt),
      ),
    )
    .returning();
  return result.length > 0;
}
