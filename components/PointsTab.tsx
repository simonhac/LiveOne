import { useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { getLogicalPathStem } from "@/lib/identifiers/logical-path";
import { SUBSYSTEM_CONFIG } from "./subsystem-config";
import micromatch from "micromatch";

interface ParsedPoint {
  stem: string; // The logical path stem (e.g., "source.solar", "bidi.battery")
  name: string;
  metricType: string;
  metricUnit: string;
}

interface PointsResponse {
  points?: Array<{
    logicalPath: string;
    name: string;
    metricType: string;
    metricUnit: string;
  }>;
}

interface PointsTabProps {
  systemId: number;
  shouldLoad?: boolean;
}

export default function PointsTab({
  systemId,
  shouldLoad = false,
}: PointsTabProps) {
  const { data, isPending } = useQuery({
    queryKey: ["system", systemId, "points"],
    queryFn: () => fetchJson<PointsResponse>(`/api/system/${systemId}/points`),
    enabled: shouldLoad,
  });

  // Extract stems at serialization boundary
  const points = useMemo<ParsedPoint[]>(() => {
    if (!data?.points || !Array.isArray(data.points)) return [];
    return data.points
      .map((p: any) => {
        const stem = getLogicalPathStem(p.logicalPath);
        if (!stem) return null;
        return {
          stem,
          name: p.name,
          metricType: p.metricType,
          metricUnit: p.metricUnit,
        };
      })
      .filter((p: ParsedPoint | null): p is ParsedPoint => p !== null);
  }, [data]);

  const loading = isPending;

  // Filter points by pattern
  const filterPoints = useCallback(
    (pattern: string) =>
      points.filter((p) => micromatch.isMatch(p.stem, pattern)),
    [points],
  );

  // Group points by subsystem
  const pointsBySubsystem = useMemo(() => {
    const solarPoints = filterPoints("source.solar*");
    const batteryPoints = filterPoints("bidi.battery*");
    const gridPoints = filterPoints("bidi.grid*");
    const loadPoints = filterPoints("load*");
    const evPoints = filterPoints("ev*");
    const inverterPoints = filterPoints("inverter*");

    // Collect points that didn't match any subsystem
    const categorizedStems = new Set<string>();
    [
      ...solarPoints,
      ...batteryPoints,
      ...gridPoints,
      ...loadPoints,
      ...evPoints,
      ...inverterPoints,
    ].forEach((p) => categorizedStems.add(p.stem));

    const otherPoints = points.filter((p) => !categorizedStems.has(p.stem));

    // Group each subsystem's points by stem to show all metric types together
    const groupByStem = (points: ParsedPoint[]) => {
      const grouped = new Map<
        string,
        { name: string; identifier: string; metricTypes: string[] }
      >();

      points.forEach((point) => {
        if (!grouped.has(point.stem)) {
          grouped.set(point.stem, {
            name: point.name,
            identifier: point.stem,
            metricTypes: [],
          });
        }
        grouped.get(point.stem)!.metricTypes.push(point.metricType);
      });

      return Array.from(grouped.values()).map((item) => ({
        ...item,
        metricTypes: [...new Set(item.metricTypes)].sort(),
      }));
    };

    return {
      solar: groupByStem(solarPoints),
      battery: groupByStem(batteryPoints),
      grid: groupByStem(gridPoints),
      load: groupByStem(loadPoints),
      ev: groupByStem(evPoints),
      inverter: groupByStem(inverterPoints),
      other: groupByStem(otherPoints),
    };
  }, [filterPoints, points]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">Loading points...</div>
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">No points found for this system.</div>
      </div>
    );
  }

  return (
    <div className="space-y-[15px]">
      <p className="text-sm text-gray-400">
        System points organized by subsystem. Points can be activated or
        deactivated via the View Data modal.
      </p>

      {(
        Object.keys(SUBSYSTEM_CONFIG) as Array<keyof typeof SUBSYSTEM_CONFIG>
      ).map((subsystem) => {
        const subsystemPoints = pointsBySubsystem[subsystem];
        if (!subsystemPoints || subsystemPoints.length === 0) {
          return null; // Skip empty subsystems
        }

        const config = SUBSYSTEM_CONFIG[subsystem];

        return (
          <div
            key={subsystem}
            className={`border rounded-none sm:rounded-lg p-3 -mx-6 sm:mx-0 sm:flex sm:gap-4 ${config.bgColor} ${config.borderColor}`}
          >
            {/* Header - Icon and Label */}
            <div className="flex items-center gap-2 mb-3 sm:mb-0 sm:flex-col sm:items-center sm:justify-start sm:min-w-[60px]">
              <config.icon
                className={`w-5 h-5 sm:w-8 sm:h-8 ${config.iconColor}`}
              />
              <h3 className="text-sm font-semibold text-gray-200 sm:text-center">
                {config.label}
              </h3>
            </div>

            {/* Content - Points */}
            <div className="flex-1 min-w-0">
              <div className="space-y-1">
                {subsystemPoints.map((item, idx) => (
                  <div key={idx} className="text-sm text-gray-300">
                    <span className="font-semibold">{item.name}</span>
                    <span className="text-gray-400 ml-2 font-sans">
                      {item.identifier}
                    </span>
                    {item.metricTypes.length > 0 && (
                      <span className="text-gray-500 ml-2 font-sans">
                        {item.metricTypes.join(", ")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
