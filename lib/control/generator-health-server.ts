/**
 * Gathers what {@link assessGeneratorHealth} needs for one area: the KV latest map, the area's
 * exercise rules (their last decision), and the newest command on the generator's control point.
 *
 * Shared by `GET /api/v4/areas/{id}/generator-health` (the tile's issues chip) and the
 * monitor-observations cron (Slack), so the two always describe the same problems.
 */
import { desc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  pointCommands,
  type ExerciseArmedContext,
} from "@/lib/db/planetscale/schema";
import { getLatestValues } from "@/lib/latest-values-store";
import { listForArea } from "@/lib/automations/store";
import { Point } from "@/lib/ids";
import {
  GENERATOR_STATUS_PATH,
  generatorRunRequestTarget,
} from "./generator-ref";
import {
  assessGeneratorHealth,
  type ExerciseRuleState,
  type GeneratorHealth,
  type LastCommand,
} from "./generator-health";

export async function loadGeneratorHealth(params: {
  areaUuid: string;
  /** The integer handle the area's KV latest map is addressed by. */
  handle: number;
  timezone: string;
  /** Automations and the command log are owner-only data; a viewer gets the device-derived issues. */
  includeOwnerData: boolean;
  nowMs?: number;
}): Promise<GeneratorHealth> {
  const nowMs = params.nowMs ?? Date.now();
  const latest = await getLatestValues(params.handle);
  if (!latest[GENERATOR_STATUS_PATH])
    return { hasGenerator: false, issues: [] };

  let exercises: ExerciseRuleState[] | null = null;
  let lastCommand: LastCommand | null = null;
  if (params.includeOwnerData) {
    const rows = await listForArea(params.areaUuid);
    exercises = rows
      .filter((r) => r.trigger?.kind === "exercise")
      .map((r) => ({
        name: r.name,
        enabled: r.enabled,
        context:
          r.armedContext && "kind" in r.armedContext
            ? (r.armedContext as ExerciseArmedContext)
            : null,
      }));

    const pt = generatorRunRequestTarget(latest);
    const pointUuid = pt ? Point.toUuidOrNull(pt) : null;
    if (pointUuid) {
      const [row] = await requirePlanetscaleDb()
        .select({
          status: pointCommands.status,
          error: pointCommands.error,
          requestedAt: pointCommands.requestedAt,
          requestedBy: pointCommands.requestedBy,
        })
        .from(pointCommands)
        .where(eq(pointCommands.pointId, pointUuid))
        .orderBy(desc(pointCommands.requestedAt))
        .limit(1);
      if (row)
        lastCommand = {
          status: row.status,
          error: row.error,
          requestedAtMs: row.requestedAt.getTime(),
          byAutomation: row.requestedBy.startsWith("automation:"),
        };
    }
  }

  return {
    hasGenerator: true,
    issues: assessGeneratorHealth({
      nowMs,
      timezone: params.timezone,
      latest,
      exercises,
      lastCommand,
    }),
  };
}
