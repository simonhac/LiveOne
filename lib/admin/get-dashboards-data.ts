/**
 * Shared function to fetch admin dashboards data (server-side rendering + API).
 *
 * A dashboard is a v4 node-tree document owned by a user; its scope refs sit on the node envelopes.
 * This powers /admin/dashboards.
 */

import { clerkClient } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  dashboards,
  shareTokens,
  dashboardGrants,
} from "@/lib/db/planetscale/schema";
import { countCardNodes, isDashboardV4 } from "@/lib/dashboard/v4";
import { Dashboard } from "@/lib/ids";

export interface AdminDashboardRow {
  id: string; // dashboards.id (uuid)
  owner: {
    clerkId: string;
    email: string | null;
    userName: string | null;
  };
  displayName: string | null;
  alias: string | null;
  cardCount: number;
  shareTokenCount: number;
  grantCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDashboardsResult {
  success: true;
  dashboards: AdminDashboardRow[];
  totalDashboards: number;
  timestamp: string;
}

export async function getAdminDashboardsData(): Promise<AdminDashboardsResult> {
  const db = requirePlanetscaleDb();

  const allDashboards = await db
    .select()
    .from(dashboards)
    .orderBy(dashboards.ownerUserId, dashboards.id);

  // Share-token and grant counts per dashboard (two grouped queries).
  const [shareRows, grantRows] = await Promise.all([
    db
      .select({
        dashboardId: shareTokens.dashboardId,
        count: sql<number>`count(*)::int`,
      })
      .from(shareTokens)
      .groupBy(shareTokens.dashboardId),
    db
      .select({
        dashboardId: dashboardGrants.dashboardId,
        count: sql<number>`count(*)::int`,
      })
      .from(dashboardGrants)
      .groupBy(dashboardGrants.dashboardId),
  ]);
  const shareCounts = new Map(shareRows.map((r) => [r.dashboardId, r.count]));
  const grantCounts = new Map(grantRows.map((r) => [r.dashboardId, r.count]));

  // Resolve owner info from Clerk.
  const ownerIds = [...new Set(allDashboards.map((d) => d.ownerUserId))];
  const userCache = new Map<
    string,
    { email: string | null; userName: string | null }
  >();
  if (ownerIds.length > 0) {
    const clerk = await clerkClient();
    await Promise.all(
      ownerIds.map(async (id) => {
        try {
          const user = await clerk.users.getUser(id);
          userCache.set(id, {
            email: user.emailAddresses[0]?.emailAddress || null,
            userName: user.username || null,
          });
        } catch (error) {
          console.warn(
            `[getAdminDashboardsData] Failed to fetch user ${id}:`,
            error,
          );
          userCache.set(id, { email: null, userName: null });
        }
      }),
    );
  }

  const dashboardsData: AdminDashboardRow[] = allDashboards.map((d) => {
    const userInfo = userCache.get(d.ownerUserId);
    return {
      // Opaque `db_…` id for the admin UI (the table read here sees the raw uuid).
      id: Dashboard.encode(d.id),
      owner: {
        clerkId: d.ownerUserId,
        email: userInfo?.email || null,
        userName: userInfo?.userName || null,
      },
      displayName: d.name,
      alias: d.slug,
      // config-v4 Phase 14 stage 15: counted off the v4 `doc`. The old v3-`descriptor` count read
      // zero for every dashboard created after the v4 cutover — the seed goes to `doc`, and
      // `descriptor` (dropped from the database by stage 16's migration 0054) stayed empty.
      // Measured on this very page at stage 13.
      cardCount: isDashboardV4(d.doc) ? countCardNodes(d.doc) : 0,
      shareTokenCount: shareCounts.get(d.id) ?? 0,
      grantCount: grantCounts.get(d.id) ?? 0,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  });

  return {
    success: true,
    dashboards: dashboardsData,
    totalDashboards: dashboardsData.length,
    timestamp: new Date().toISOString(),
  };
}
