/**
 * Shared function to fetch admin dashboards data (server-side rendering + API).
 *
 * A dashboard is a v3 composition descriptor owned by a user; its cards each carry their own Area.
 * This powers /admin/dashboards.
 */

import { clerkClient } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  dashboards,
  dashboardShareTokens,
  dashboardGrants,
} from "@/lib/db/planetscale/schema";
import { allCardsV3, isDashboardV3 } from "@/lib/dashboard/v3";

export interface AdminDashboardRow {
  id: number;
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
    .orderBy(dashboards.clerkUserId, dashboards.id);

  // Share-token and grant counts per dashboard (two grouped queries).
  const [shareRows, grantRows] = await Promise.all([
    db
      .select({
        dashboardId: dashboardShareTokens.dashboardId,
        count: sql<number>`count(*)::int`,
      })
      .from(dashboardShareTokens)
      .groupBy(dashboardShareTokens.dashboardId),
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
  const ownerIds = [...new Set(allDashboards.map((d) => d.clerkUserId))];
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
    const userInfo = userCache.get(d.clerkUserId);
    return {
      id: d.id,
      owner: {
        clerkId: d.clerkUserId,
        email: userInfo?.email || null,
        userName: userInfo?.userName || null,
      },
      displayName: d.displayName,
      alias: d.alias,
      cardCount: isDashboardV3(d.descriptor)
        ? allCardsV3(d.descriptor).length
        : 0,
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
