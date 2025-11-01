import { useState, useEffect, useMemo, useRef } from "react";
import { Check } from "lucide-react";

interface Capability {
  type: string;
  subtype: string | null;
  extension: string | null;
}

interface CapabilityNode {
  key: string; // type.subtype.extension
  label: string;
  children?: CapabilityNode[];
  level: number;
}

interface CapabilitiesTabProps {
  systemId: number;
  shouldLoad?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onSaveFunctionReady?: (saveFunction: () => Promise<string[]>) => void;
}

// Helper: Build all parent paths from a capability path string
const buildParentPaths = (path: string): string[] => {
  const parts = path.split(".");
  const paths: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    paths.push(parts.slice(0, i).join("."));
  }
  return paths;
};

export default function CapabilitiesTab({
  systemId,
  shouldLoad = false,
  onDirtyChange,
  onSaveFunctionReady,
}: CapabilitiesTabProps) {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [availableCapabilities, setAvailableCapabilities] = useState<
    Set<string>
  >(new Set());
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [initialEnabled, setInitialEnabled] = useState<Set<string>>(new Set());
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
      fetchCapabilities();
    }
  }, [systemId, shouldLoad, hasLoaded]);

  const fetchCapabilities = async () => {
    fetchingRef.current = true;
    try {
      const response = await fetch(`/api/admin/systems/${systemId}/settings`);
      const data = await response.json();

      console.log("Loaded settings:", data);

      if (data.success) {
        // Store available capabilities as a Set for fast lookup
        const availableSet = new Set<string>(data.availableCapabilities);
        setAvailableCapabilities(availableSet);

        // Convert flattened strings back to Capability objects for tree building
        const capabilityObjects: Capability[] = data.availableCapabilities.map(
          (path: string) => {
            const parts = path.split(".");
            return {
              type: parts[0],
              subtype: parts[1] !== undefined ? parts[1] : null,
              extension: parts[2] !== undefined ? parts[2] : null,
            };
          },
        );
        setCapabilities(capabilityObjects);

        // Load enabled capabilities (default to all if none saved)
        // Only load capabilities that actually have checkboxes (are in availableCapabilities)
        const savedCapabilities =
          !data.settings.capabilities || data.settings.capabilities.length === 0
            ? data.availableCapabilities
            : data.settings.capabilities.filter((cap: string) =>
                availableSet.has(cap),
              );

        // Warn if any invalid capabilities were filtered out
        if (
          data.settings.capabilities &&
          data.settings.capabilities.length > 0
        ) {
          const invalidCaps = data.settings.capabilities.filter(
            (cap: string) => !availableSet.has(cap),
          );
          if (invalidCaps.length > 0) {
            console.warn(
              "Filtered out invalid capabilities on load:",
              invalidCaps,
            );
          }
        }

        const enabledSet = new Set<string>(savedCapabilities);

        setEnabled(enabledSet);
        setInitialEnabled(new Set(enabledSet));
        setHasLoaded(true);
      }
    } catch (error) {
      console.error("Failed to fetch capabilities:", error);
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

  // Build tree structure from flat capabilities
  const tree = useMemo(() => {
    const nodeMap = new Map<string, CapabilityNode>();

    capabilities.forEach((cap) => {
      const parts = [cap.type, cap.subtype, cap.extension].filter(
        (p): p is string => Boolean(p),
      );

      // Build all parent paths
      for (let i = 1; i <= parts.length; i++) {
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
          });
        }
      }
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
  }, [capabilities]);

  // Check if capabilities are dirty
  const isDirty = useMemo(() => {
    if (enabled.size !== initialEnabled.size) return true;
    for (const key of enabled) {
      if (!initialEnabled.has(key)) return true;
    }
    return false;
  }, [enabled, initialEnabled]);

  // Notify parent when dirty state changes
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Log capabilities to console when they change
  useEffect(() => {
    if (hasLoaded) {
      const enabledArray = Array.from(enabled);
      console.log("Capabilities:", enabledArray);
    }
  }, [enabled, hasLoaded]);

  // Get capabilities data for saving (called by parent)
  // Only save items that are actual capabilities (in availableCapabilities)
  const getCapabilitiesData = async (): Promise<string[]> => {
    const allEnabled = Array.from(enabled);
    const validCapabilities = allEnabled.filter((key) =>
      availableCapabilities.has(key),
    );

    // Warn if any invalid capabilities are being filtered out
    const invalidCaps = allEnabled.filter(
      (key) => !availableCapabilities.has(key),
    );
    if (invalidCaps.length > 0) {
      console.warn(
        "Filtered out invalid capabilities before save:",
        invalidCaps,
      );
    }

    return validCapabilities;
  };

  // Expose data getter to parent
  useEffect(() => {
    onSaveFunctionReady?.(getCapabilitiesData);
  }, [enabled, availableCapabilities, onSaveFunctionReady]);

  const handleToggle = (nodeKey: string) => {
    const newEnabled = new Set(enabled);

    if (newEnabled.has(nodeKey)) {
      newEnabled.delete(nodeKey);
    } else {
      newEnabled.add(nodeKey);
    }

    setEnabled(newEnabled);
  };

  const renderNode = (node: CapabilityNode) => {
    const hasChildren = node.children && node.children.length > 0;
    const isActualCapability = availableCapabilities.has(node.key);
    const isEnabled = enabled.has(node.key);

    return (
      <div key={node.key}>
        <div
          className="flex items-center gap-2 py-1 hover:bg-gray-700/30 rounded px-2 -mx-2"
          style={{ paddingLeft: `${node.level * 20 + 8}px` }}
        >
          {/* Checkbox - only show for actual capabilities */}
          {isActualCapability && (
            <div
              className={`w-4 h-4 border-2 rounded flex items-center justify-center transition-colors cursor-pointer ${
                isEnabled
                  ? "bg-blue-600 border-blue-600"
                  : "border-gray-600 bg-gray-900"
              }`}
              onClick={() => handleToggle(node.key)}
            >
              {isEnabled && <Check className="w-3 h-3 text-white" />}
            </div>
          )}

          {/* Label */}
          <span
            className={`text-sm ${
              isActualCapability
                ? isEnabled
                  ? "text-gray-100"
                  : "text-gray-500"
                : "text-gray-300"
            } ${node.level === 0 ? "font-semibold" : ""} ${
              isActualCapability ? "cursor-pointer" : ""
            }`}
            onClick={() => isActualCapability && handleToggle(node.key)}
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

  if (tree.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">
          No capabilities found for this system.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">{tree.map((node) => renderNode(node))}</div>
  );
}
