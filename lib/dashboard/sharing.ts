/**
 * Per-dashboard sharing (P4): dashboard-scoped share tokens + grant lookups.
 *
 * A share token is a read-only public link scoped to ONE dashboard (unlike the legacy owner-scoped
 * `share_tokens`). A holder gets read access to exactly the points that dashboard exposes
 * (lib/dashboard/access.ts), resolved at consumption time — never general system access. Reuses the
 * 3-word phrase generator + epoch-ms / revoke / expiry convention from lib/share-tokens.ts.
 */
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboardShareTokens } from "@/lib/db/planetscale/schema";
import { generateTokenString, isWellFormedToken } from "@/lib/share-tokens";

export interface CreateDashboardShareTokenOptions {
  dashboardId: number;
  expiresInDays?: number | null; // null/undefined => never expires
  label?: string | null;
}

export async function createDashboardShareToken(
  opts: CreateDashboardShareTokenOptions,
): Promise<{ token: string; expiresAtMs: number | null }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateTokenString();
    const expiresAtMs =
      opts.expiresInDays && opts.expiresInDays > 0
        ? Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000
        : null;
    try {
      await requirePlanetscaleDb()
        .insert(dashboardShareTokens)
        .values({
          token,
          dashboardId: opts.dashboardId,
          label: opts.label ?? null,
          createdAtMs: Date.now(),
          expiresAtMs,
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
  dashboardId: number;
}

/** Validate a token (well-formed, not revoked, not expired) → its dashboard, touching last_used. */
export async function validateDashboardShareToken(
  token: string,
): Promise<ValidatedDashboardToken | null> {
  if (!isWellFormedToken(token)) return null;
  const nowMs = Date.now();
  const pg = requirePlanetscaleDb();
  const rows = await pg
    .select()
    .from(dashboardShareTokens)
    .where(
      and(
        eq(dashboardShareTokens.token, token),
        isNull(dashboardShareTokens.revokedAtMs),
        or(
          isNull(dashboardShareTokens.expiresAtMs),
          gt(dashboardShareTokens.expiresAtMs, nowMs),
        ),
      ),
    )
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;

  void pg
    .update(dashboardShareTokens)
    .set({ lastUsedAtMs: nowMs })
    .where(eq(dashboardShareTokens.token, token))
    .catch(() => {});

  return { token: row.token, dashboardId: row.dashboardId };
}

export async function listDashboardShareTokens(dashboardId: number) {
  return requirePlanetscaleDb()
    .select()
    .from(dashboardShareTokens)
    .where(eq(dashboardShareTokens.dashboardId, dashboardId))
    .orderBy(desc(dashboardShareTokens.createdAtMs));
}

/** Revoke a token, scoped to its dashboard (the route verifies the caller owns that dashboard). */
export async function revokeDashboardShareToken(
  token: string,
  dashboardId: number,
): Promise<boolean> {
  const result = await requirePlanetscaleDb()
    .update(dashboardShareTokens)
    .set({ revokedAtMs: Date.now() })
    .where(
      and(
        eq(dashboardShareTokens.token, token),
        eq(dashboardShareTokens.dashboardId, dashboardId),
        isNull(dashboardShareTokens.revokedAtMs),
      ),
    )
    .returning();
  return result.length > 0;
}
