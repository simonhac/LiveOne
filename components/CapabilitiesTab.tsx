import { useState, useEffect, useMemo, useRef } from "react";
import { Sun, Battery, Zap, Home, Activity } from "lucide-react";

interface PointInfo {
  id: number; // point ID within system
  systemId: number;
  displayName: string;
  subsystem: string | null;
  type: string | null; // series ID type component (e.g., "source", "load", "bidi")
  subtype: string | null;
  extension: string | null;
  metricType: string; // metric type (e.g., "power", "energy", "soc")
  metricUnit: string;
  active: boolean;
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

interface CapabilitiesTabProps {
  systemId: number;
  shouldLoad?: boolean;
}

export default function CapabilitiesTab({
  systemId,
  shouldLoad = false,
}: CapabilitiesTabProps) {
  const [points, setPoints] = useState<PointInfo[]>([]);
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

  useEffect(() => {
    if (shouldLoad && !hasLoaded && !fetchingRef.current) {
      fetchPoints();
    }
  }, [systemId, shouldLoad, hasLoaded]);

  const fetchPoints = async () => {
    fetchingRef.current = true;
    try {
      const response = await fetch(
        `/api/admin/systems/${systemId}/point-readings?limit=1`,
      );
      const data = await response.json();

      if (data.headers) {
        // Convert headers to PointInfo objects, filtering out timestamp and sessionLabel columns
        const pointsData: PointInfo[] = data.headers
          .filter((h: any) => h.key !== "timestamp" && h.key !== "sessionLabel")
          .map((h: any) => ({
            id: h.pointDbId,
            systemId: h.systemId,
            displayName: h.label,
            subsystem: h.subsystem,
            type: h.pointType || null,
            subtype: h.subtype || null,
            extension: h.extension || null,
            metricType: h.type,
            metricUnit: h.unit,
            active: h.active,
          }));

        setPoints(pointsData);
        setHasLoaded(true);
      }
    } catch (error) {
      console.error("Failed to fetch points:", error);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  };

  // Group points by subsystem and get paths with their metric types
  const pointsBySubsystem = useMemo(() => {
    const grouped: Record<
      string,
      Array<{ path: string; metricTypes: string[] }>
    > = {
      solar: [],
      battery: [],
      grid: [],
      load: [],
      inverter: [],
      other: [],
    };

    // Build a map of path -> metric types
    const pathToMetricTypes = new Map<string, Set<string>>();

    points.forEach((point) => {
      // Only include points that have a type
      if (!point.type) return;

      const parts = [point.type, point.subtype, point.extension].filter(
        (part): part is string => Boolean(part),
      );
      const path = parts.join(".");

      if (!path) return;

      // Use the actual metric type from the database
      const metricType = point.metricType;

      if (!pathToMetricTypes.has(path)) {
        pathToMetricTypes.set(path, new Set());
      }
      pathToMetricTypes.get(path)!.add(metricType);
    });

    // Now group by subsystem
    points.forEach((point) => {
      if (!point.type) return;

      const subsystem = point.subsystem || "other";
      const parts = [point.type, point.subtype, point.extension].filter(
        (part): part is string => Boolean(part),
      );
      const path = parts.join(".");

      if (!path) return;

      const metricTypes = Array.from(pathToMetricTypes.get(path) || []).sort();

      const targetArray = grouped[subsystem] || grouped.other;
      // Only add if not already present
      if (!targetArray.some((item) => item.path === path)) {
        targetArray.push({ path, metricTypes });
      }
    });

    // Sort paths within each subsystem
    Object.keys(grouped).forEach((key) => {
      grouped[key].sort((a, b) => a.path.localeCompare(b.path));
    });

    return grouped;
  }, [points]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">Loading capabilities...</div>
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">
          No capabilities found for this system.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-[15px]">
      <p className="text-sm text-gray-400">
        System capabilities organized by subsystem. Points can be activated or
        deactivated via the View Data modal.
      </p>

      {(
        Object.keys(SUBSYSTEM_CONFIG) as Array<keyof typeof SUBSYSTEM_CONFIG>
      ).map((subsystem) => {
        const subsystemPaths = pointsBySubsystem[subsystem];
        if (!subsystemPaths || subsystemPaths.length === 0) {
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

            {/* Content - Point Paths */}
            <div className="flex-1 min-w-0">
              <div className="space-y-1">
                {subsystemPaths.map((item) => (
                  <div key={item.path} className="text-sm text-gray-300">
                    <span className="font-sans">{item.path}</span>
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
