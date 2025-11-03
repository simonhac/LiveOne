import { useState, useEffect, useMemo, useRef } from "react";
import { Sun, Battery, Zap, Home, Activity } from "lucide-react";

interface PointInfo {
  pointDbId: number;
  label: string;
  subsystem: string | null;
  type: string | null; // type component of series ID
  subtype: string | null;
  extension: string | null;
  active: boolean;
}

interface CapabilityNode {
  key: string; // type.subtype.extension or type.subtype.extension.metricType (for leaf nodes)
  label: string;
  children?: CapabilityNode[];
  level: number;
  isLeaf: boolean; // True if this is an actual point (not just a grouping node)
  active?: boolean; // Only set for leaf nodes
  subsystem?: string | null; // Only set for leaf nodes
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
        // Convert headers to PointInfo objects, filtering out timestamp column
        const pointsData: PointInfo[] = data.headers
          .filter((h: any) => h.key !== "timestamp")
          .map((h: any) => ({
            pointDbId: h.pointDbId,
            label: h.label,
            subsystem: h.subsystem,
            type: h.pointType || null,
            subtype: h.subtype || null,
            extension: h.extension || null,
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

  // Helper to get display label for a capability part
  const getDisplayLabel = (label: string, level: number): string => {
    // For top-level types (level 0), use proper display names
    if (level === 0) {
      const typeLabels: Record<string, string> = {
        bidi: "Bidirectional",
        load: "Load",
        source: "Source",
      };
      return typeLabels[label.toLowerCase()] || label;
    }
    return label;
  };

  // Group points by subsystem
  const pointsBySubsystem = useMemo(() => {
    const grouped: Record<string, PointInfo[]> = {
      solar: [],
      battery: [],
      grid: [],
      load: [],
      inverter: [],
      other: [],
    };

    points.forEach((point) => {
      const subsystem = point.subsystem || "other";
      if (grouped[subsystem]) {
        grouped[subsystem].push(point);
      } else {
        grouped.other.push(point);
      }
    });

    return grouped;
  }, [points]);

  // Build tree structure for a given subsystem's points
  const buildTreeForSubsystem = (
    subsystemPoints: PointInfo[],
  ): CapabilityNode[] => {
    const nodeMap = new Map<string, CapabilityNode>();

    // Only include points that have a series ID (type is not null)
    const pointsWithSeriesId = subsystemPoints.filter((p) => p.type);

    pointsWithSeriesId.forEach((point) => {
      // Build series ID path: type.subtype.extension
      const parts = [point.type, point.subtype, point.extension].filter(
        (p): p is string => Boolean(p),
      );

      // Build all parent paths (grouping nodes)
      for (let i = 1; i < parts.length; i++) {
        const pathParts = parts.slice(0, i);
        const key = pathParts.join(".");
        const rawLabel = pathParts[pathParts.length - 1];
        const label = getDisplayLabel(rawLabel, i - 1);

        if (!nodeMap.has(key)) {
          nodeMap.set(key, {
            key,
            label,
            children: [],
            level: i - 1,
            isLeaf: false,
          });
        }
      }

      // Add the point itself as a leaf node (use the display label)
      const pointKey = parts.join(".");
      nodeMap.set(pointKey, {
        key: pointKey,
        label: point.label,
        children: [],
        level: parts.length - 1,
        isLeaf: true,
        active: point.active,
        subsystem: point.subsystem,
      });
    });

    // Build parent-child relationships
    nodeMap.forEach((node) => {
      const parts = node.key.split(".");
      if (parts.length > 1) {
        const parentKey = parts.slice(0, -1).join(".");
        const parent = nodeMap.get(parentKey);
        if (parent && !parent.children!.some((c) => c.key === node.key)) {
          parent.children!.push(node);
        }
      }
    });

    // Get root nodes (level 0)
    const roots = Array.from(nodeMap.values()).filter((n) => n.level === 0);

    // Sort children at each level
    const sortChildren = (nodes: CapabilityNode[]) => {
      nodes.sort((a, b) => a.label.localeCompare(b.label));
      nodes.forEach((node) => {
        if (node.children && node.children.length > 0) {
          sortChildren(node.children);
        }
      });
    };

    sortChildren(roots);

    return roots;
  };

  const renderNode = (node: CapabilityNode) => {
    const hasChildren = node.children && node.children.length > 0;
    const isActive = node.isLeaf ? node.active : true;
    const textColor = node.isLeaf
      ? isActive
        ? "text-gray-300"
        : "text-gray-600"
      : "text-gray-300";

    return (
      <div key={node.key}>
        <div
          className="flex items-center gap-2 py-0.5 px-2"
          style={{ paddingLeft: `${node.level * 16 + 8}px` }}
        >
          <span
            className={`text-sm ${textColor} ${
              node.level === 0 ? "font-semibold" : ""
            } ${node.isLeaf && !isActive ? "line-through" : ""}`}
          >
            {node.label}
            {hasChildren ? ":" : ""}
          </span>
        </div>

        {/* Render children */}
        {hasChildren && (
          <div>{node.children!.map((child) => renderNode(child))}</div>
        )}
      </div>
    );
  };

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
        const subsystemPoints = pointsBySubsystem[subsystem];
        if (!subsystemPoints || subsystemPoints.length === 0) {
          return null; // Skip empty subsystems
        }

        const config = SUBSYSTEM_CONFIG[subsystem];
        const tree = buildTreeForSubsystem(subsystemPoints);

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

            {/* Content - Capability Tree */}
            <div className="flex-1 min-w-0">
              {tree.length > 0 ? (
                <div className="space-y-0.5">
                  {tree.map((node) => renderNode(node))}
                </div>
              ) : (
                <div className="text-sm text-gray-500 italic py-1">
                  No {subsystem} points configured
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
