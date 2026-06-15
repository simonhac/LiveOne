/**
 * Shared function to fetch admin dashboards data (server-side rendering + API).
 *
 * A dashboard is a per-user, per-system presentation descriptor (P2). Access is keyed on
 * (clerk_user_id, system_id); `area_id` is the forward seam. This powers /admin/dashboards.
 */

import { clerkClient } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  dashboards,
  dashboardShareTokens,
  dashboardGrants,
} from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import type { DashboardDescriptor } from "@/lib/dashboard/descriptor";

export interface AdminDashboardRow {
  id: number;
  owner: {
    clerkId: string;
    email: string | null;
    userName: string | null;
  };
  systemId: number;
  systemName: string | null;
  areaId: string | null;
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
  const systemsManager = SystemsManager.getInstance();

  const allDashboards = await db
    .select()
    .from(dashboards)
    .orderBy(dashboards.clerkUserId, dashboards.systemId);

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

  // Resolve system display names (works for real + composite handles).
  const systemIds = [...new Set(allDashboards.map((d) => d.systemId))];
  const systemNames = new Map<number, string>();
  await Promise.all(
    systemIds.map(async (id) => {
      const system = await systemsManager.getSystem(id);
      if (system) systemNames.set(id, system.displayName);
    }),
  );

  const dashboardsData: AdminDashboardRow[] = allDashboards.map((d) => {
    const userInfo = userCache.get(d.clerkUserId);
    const descriptor = d.descriptor as DashboardDescriptor | null;
    return {
      id: d.id,
      owner: {
        clerkId: d.clerkUserId,
        email: userInfo?.email || null,
        userName: userInfo?.userName || null,
      },
      systemId: d.systemId,
      systemName: systemNames.get(d.systemId) ?? null,
      areaId: d.areaId,
      cardCount: descriptor?.cards?.length ?? 0,
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
