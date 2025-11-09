/**
 * Point Manager - Backend-only manager for monitoring points
 * DO NOT import this on the frontend - use PointInfo directly instead
 */

import { db } from "@/lib/db";
import { pointInfo as pointInfoTable } from "@/lib/db/schema-monitoring-points";
import { eq } from "drizzle-orm";
import { PointInfo } from "@/lib/point-info";

/**
 * Manages monitoring points for systems (backend only)
 */
export class PointManager {
  private static instance: PointManager;

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): PointManager {
    if (!PointManager.instance) {
      PointManager.instance = new PointManager();
    }
    return PointManager.instance;
  }

  /**
   * Get all points for a system
   */
  async getPointsForSystem(systemId: number): Promise<PointInfo[]> {
    const rows = await db
      .select()
      .from(pointInfoTable)
      .where(eq(pointInfoTable.systemId, systemId));

    return rows.map((row) => PointInfo.from(row));
  }

  /**
   * Get a specific point by system ID and point ID
   */
  async getPoint(systemId: number, pointId: number): Promise<PointInfo | null> {
    const rows = await db
      .select()
      .from(pointInfoTable)
      .where(eq(pointInfoTable.systemId, systemId));

    const point = rows.find((row) => row.id === pointId);
    return point ? PointInfo.from(point) : null;
  }
}
