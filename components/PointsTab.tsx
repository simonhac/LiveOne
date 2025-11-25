import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Sun, Battery, Zap, Home, Activity } from "lucide-react";
import {
  parsePointPath,
  ParsedPointPath,
  getIdentifierFromParsed,
} from "@/lib/identifiers/point-path-utils";
import micromatch from "micromatch";

interface ParsedPoint {
  pointPath: ParsedPointPath;
  name: string;
  metricType: string;
  metricUnit: string;
}

const SUBSYSTEM_CONFIG = {
  solar: {
    label: "Solar",
    icon: Sun,
    iconColor: "text-yellow-400",
    bgColor: "bg-yellow-500/10",
    borderColor: "border-yellow-500/30",
  },
  battery: {
    label: "Battery",
    icon: Battery,
    iconColor: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/30",
  },
  grid: {
    label: "Grid",
    icon: Zap,
    iconColor: "text-green-400",
    bgColor: "bg-green-500/10",
    borderColor: "border-green-500/30",
  },
  load: {
    label: "Load",
    icon: Home,
    iconColor: "text-red-400",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500/30",
  },
  inverter: {
    label: "Inverter",
    icon: Activity,
    iconColor: "text-orange-400",
    bgColor: "bg-orange-500/10",
    borderColor: "border-orange-500/30",
  },
  other: {
    label: "Other",
    icon: Activity,
    iconColor: "text-gray-400",
    bgColor: "bg-gray-500/10",
    borderColor: "border-gray-500/30",
  },
} as const;

interface PointsTabProps {
  systemId: number;
  shouldLoad?: boolean;
}

export default function PointsTab({
  systemId,
  shouldLoad = false,
}: PointsTabProps) {
  const [points, setPoints] = useState<ParsedPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const fetchingRef = useRef(false);

  // Reset hasLoaded when modal closes so it will reload next time
  useEffect(() => {
    if (!shouldLoad && hasLoaded) {
      setHasLoaded(false);
      setLoading(true);
      fetchingRef.current = false;
    }
  }, [shouldLoad, hasLoaded]);

  const fetchPoints = useCallback(async () => {
    fetchingRef.current = true;
    try {
      const response = await fetch(`/api/system/${systemId}/points`);
      const data = await response.json();

      if (data.points && Array.isArray(data.points)) {
        // Parse paths at serialization boundary
        const parsedPoints: ParsedPoint[] = data.points
          .map((p: any) => {
            const pointPath = parsePointPath(p.logicalPath);
            if (!pointPath) return null;
            return {
              pointPath,
              name: p.name,
              metricType: p.metricType,
              metricUnit: p.metricUnit,
            };
          })
          .filter((p: ParsedPoint | null): p is ParsedPoint => p !== null);

        setPoints(parsedPoints);
        setHasLoaded(true);
      }
    } catch (error) {
      console.error("Failed to fetch points:", error);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [systemId]);

  useEffect(() => {
    if (shouldLoad && !hasLoaded && !fetchingRef.current) {
      fetchPoints();
    }
  }, [systemId, shouldLoad, hasLoaded, fetchPoints]);

  // Filter points by pattern
  const filterPoints = useCallback(
    (pattern: string) =>
      points.filter((p) =>
        micromatch.isMatch(getIdentifierFromParsed(p.pointPath), pattern),
      ),
    [points],
  );

  // Group points by subsystem
  const pointsBySubsystem = useMemo(() => {
    const solarPoints = filterPoints("source.solar*");
    const batteryPoints = filterPoints("bidi.battery*");
    const gridPoints = filterPoints("bidi.grid*");
    const loadPoints = filterPoints("load*");
    const inverterPoints = filterPoints("inverter*");

    // Collect points that didn't match any subsystem
    const categorizedIdentifiers = new Set<string>();
    [
      ...solarPoints,
      ...batteryPoints,
      ...gridPoints,
      ...loadPoints,
      ...inverterPoints,
    ].forEach((p) =>
      categorizedIdentifiers.add(getIdentifierFromParsed(p.pointPath)),
    );

    const otherPoints = points.filter(
      (p) => !categorizedIdentifiers.has(getIdentifierFromParsed(p.pointPath)),
    );

    // Group each subsystem's points by identifier to show all metric types together
    const groupByIdentifier = (points: ParsedPoint[]) => {
      const grouped = new Map<
        string,
        { name: string; identifier: string; metricTypes: string[] }
      >();

      points.forEach((point) => {
        const identifier = getIdentifierFromParsed(point.pointPath);
        if (!grouped.has(identifier)) {
          grouped.set(identifier, {
            name: point.name,
            identifier,
            metricTypes: [],
          });
        }
        grouped.get(identifier)!.metricTypes.push(point.metricType);
      });

      return Array.from(grouped.values()).map((item) => ({
        ...item,
        metricTypes: [...new Set(item.metricTypes)].sort(),
      }));
    };

    return {
      solar: groupByIdentifier(solarPoints),
      battery: groupByIdentifier(batteryPoints),
      grid: groupByIdentifier(gridPoints),
      load: groupByIdentifier(loadPoints),
      inverter: groupByIdentifier(inverterPoints),
      other: groupByIdentifier(otherPoints),
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
