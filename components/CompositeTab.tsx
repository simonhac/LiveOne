import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Plus, X, Sun, Home, Battery, Zap } from "lucide-react";
import { createPortal } from "react-dom";
import { useUser } from "@clerk/nextjs";
import { stemSplit } from "@/lib/identifiers/logical-path";

interface CompositeMapping {
  [key: string]: string[]; // Allow any category keys
}

interface AvailablePoint {
  id: string; // Format: "systemId.pointId"
  path: string; // Series ID path like "source.solar.local"
  name: string; // Display name
  systemId: number;
  systemName: string;
  metricType: string; // e.g., "power", "energy", "soc"
}

interface CompositeTabProps {
  systemId: number;
  shouldLoad?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onSaveFunctionReady?: (saveFunction: () => Promise<CompositeMapping>) => void;
  ownerUserId?: string; // Optional: owner user ID for fetching points (for new systems)
}

const CATEGORY_CONFIG = {
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
  load: {
    label: "Load",
    icon: Home,
    iconColor: "text-red-400",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500/30",
  },
  grid: {
    label: "Grid",
    icon: Zap,
    iconColor: "text-green-400",
    bgColor: "bg-green-500/10",
    borderColor: "border-green-500/30",
  },
};

export default function CompositeTab({
  systemId,
  shouldLoad = false,
  onDirtyChange,
  onSaveFunctionReady,
  ownerUserId,
}: CompositeTabProps) {
  const { user } = useUser();
  const [mappings, setMappings] = useState<CompositeMapping>({
    solar: [],
    battery: [],
    load: [],
    grid: [],
  });
  const [initialMappings, setInitialMappings] = useState<CompositeMapping>({
    solar: [],
    battery: [],
    load: [],
    grid: [],
  });
  const [availablePoints, setAvailablePoints] = useState<AvailablePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [addingToCategory, setAddingToCategory] = useState<string | null>(null);
  const [menuButtonRef, setMenuButtonRef] = useState<HTMLButtonElement | null>(
    null,
  );
  const fetchingRef = useRef(false);

  // Handle Escape key to close menu
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && addingToCategory) {
        e.stopPropagation(); // Prevent event from bubbling to parent dialog
        handleCloseMenu();
      }
    };

    if (addingToCategory) {
      document.addEventListener("keydown", handleKeyDown, true); // Use capture phase
      return () => {
        document.removeEventListener("keydown", handleKeyDown, true);
      };
    }
  }, [addingToCategory]);

  // Reset hasLoaded when modal closes
  useEffect(() => {
    if (!shouldLoad && hasLoaded) {
      setHasLoaded(false);
      setLoading(true);
      fetchingRef.current = false;
    }
  }, [shouldLoad, hasLoaded]);

  const fetchCompositeConfig = useCallback(async () => {
    fetchingRef.current = true;
    try {
      // Determine which user ID to use for fetching points
      // Priority: ownerUserId prop > current user ID
      const userId = ownerUserId || user?.id;

      if (!userId) {
        console.error("No user ID available to fetch points");
        setLoading(false);
        fetchingRef.current = false;
        return;
      }

      // Fetch available points from user's systems
      const pointsResponse = await fetch(`/api/admin/user/${userId}/points`);
      const pointsData = await pointsResponse.json();

      if (!pointsData.success) {
        console.error("Failed to fetch available points");
        return;
      }

      setAvailablePoints(pointsData.availablePoints || []);

      // For new systems (systemId=-1), initialize with empty mappings
      if (systemId === -1) {
        const emptyMappings: CompositeMapping = {
          solar: [],
          battery: [],
          load: [],
          grid: [],
        };

        setMappings(emptyMappings);
        setInitialMappings(JSON.parse(JSON.stringify(emptyMappings)));
        setHasLoaded(true);
      } else {
        // For existing systems, fetch their composite configuration
        const configResponse = await fetch(
          `/api/admin/systems/${systemId}/composite-config`,
        );
        const configData = await configResponse.json();

        if (configData.success) {
          // Parse existing mappings from metadata
          const metadata = configData.metadata || {};
          const currentMappings: CompositeMapping = metadata.mappings || {
            solar: [],
            battery: [],
            load: [],
            grid: [],
          };

          setMappings(currentMappings);
          setInitialMappings(JSON.parse(JSON.stringify(currentMappings)));
          setHasLoaded(true);
        }
      }
    } catch (error) {
      console.error("Failed to fetch composite config:", error);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [systemId, ownerUserId, user?.id]);

  useEffect(() => {
    if (shouldLoad && !hasLoaded && !fetchingRef.current) {
      fetchCompositeConfig();
    }
  }, [systemId, shouldLoad, hasLoaded, fetchCompositeConfig]);

  // Check if mappings are dirty
  const isDirty = useMemo(() => {
    return JSON.stringify(mappings) !== JSON.stringify(initialMappings);
  }, [mappings, initialMappings]);

  // Notify parent when dirty state changes
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Provide save function to parent
  const getMappingsData = useCallback(async (): Promise<CompositeMapping> => {
    return mappings;
  }, [mappings]);

  useEffect(() => {
    onSaveFunctionReady?.(getMappingsData);
  }, [onSaveFunctionReady, getMappingsData]);

  // Helper to get display label components for a point ID
  const getDisplayLabelParts = (
    pointId: string, // Format: "systemId.pointId"
  ): {
    systemName: string;
    pointName: string;
    path: string;
    metricType: string;
  } | null => {
    const point = availablePoints.find((p) => p.id === pointId);

    if (point) {
      return {
        systemName: point.systemName,
        pointName: point.name,
        path: point.path,
        metricType: point.metricType,
      };
    }

    // Fallback: parse the ID - but we don't have path/metricType info
    const parts = pointId.split(".");
    if (parts.length !== 2) return null;

    return {
      systemName: `System ${parts[0]}`,
      pointName: `Point ${parts[1]}`,
      path: "",
      metricType: "",
    };
  };

  const handleAddMapping = (
    category: string,
    buttonElement: HTMLButtonElement,
  ) => {
    console.log(
      "Opening menu for category:",
      category,
      "button:",
      buttonElement,
    );
    setAddingToCategory(category);
    setMenuButtonRef(buttonElement);
  };

  const handleCloseMenu = () => {
    setAddingToCategory(null);
    setMenuButtonRef(null);
  };

  const handleSelectPoint = (
    category: string,
    point: AvailablePoint,
    keepMenuOpen: boolean = false,
  ) => {
    setMappings((prev) => ({
      ...prev,
      [category]: [...(prev[category] || []), point.id],
    }));
    if (!keepMenuOpen) {
      handleCloseMenu();
    }
  };

  const handleRemoveMapping = (category: string, index: number) => {
    setMappings((prev) => ({
      ...prev,
      [category]: (prev[category] || []).filter((_, i) => i !== index),
    }));
  };

  // Helper to check if a path matches a pattern
  const matchesPattern = (path: string, pattern: string): boolean => {
    const segments = stemSplit(path);
    if (segments.length === 0) return false;

    // Parse the pattern to get type and subtype
    const patternParts = pattern.split(".");
    const patternType = patternParts[0];
    const patternSubtype = patternParts.length > 1 ? patternParts[1] : null;

    // Match type
    if (segments[0] !== patternType) return false;

    // If pattern has subtype, match it (but ignore extension)
    if (patternSubtype && segments[1] !== patternSubtype) return false;

    // If pattern only has type, any subtype matches
    return true;
  };

  // Filter available points for selection
  const getAvailableForCategory = (category: string): AvailablePoint[] => {
    // Map UI categories to series ID path patterns
    const categoryPatterns: Record<string, string> = {
      solar: "source.solar",
      battery: "bidi.battery",
      load: "load",
      grid: "bidi.grid",
    };

    // Get already-added point IDs for this category
    const addedIds = new Set(mappings[category] || []);

    return availablePoints.filter((point) => {
      // Check if it matches the category pattern (if pattern exists)
      const pattern = categoryPatterns[category];
      if (pattern && !matchesPattern(point.path, pattern)) {
        return false;
      }

      // Exclude if already added to this category
      return !addedIds.has(point.id);
    });
  };

  // Render popup menu
  const renderPopupMenu = () => {
    if (
      !addingToCategory ||
      !menuButtonRef ||
      typeof document === "undefined"
    ) {
      console.log("Popup menu not rendering:", {
        addingToCategory,
        menuButtonRef,
        document: typeof document,
      });
      return null;
    }

    console.log("Rendering popup menu for:", addingToCategory);
    const availableForCategory = getAvailableForCategory(addingToCategory);

    // Calculate position
    const rect = menuButtonRef.getBoundingClientRect();
    const menuWidth = 320;
    const minMargin = 50; // Minimum margin from window edges
    const gap = 4; // Gap between button and menu

    // Calculate maximum available height based on window size
    const spaceBelow = window.innerHeight - rect.bottom - minMargin;
    const spaceAbove = rect.top - minMargin;

    // Try to position below the button first
    let positionAbove = false;
    let menuMaxHeight: number;

    if (spaceBelow >= 200) {
      // Enough space below
      menuMaxHeight = Math.min(spaceBelow - gap, 600); // Cap at 600px max
      positionAbove = false;
    } else if (spaceAbove >= 200) {
      // Not enough space below, but enough above
      menuMaxHeight = Math.min(spaceAbove - gap, 600);
      positionAbove = true;
    } else {
      // Use whichever side has more space
      if (spaceAbove > spaceBelow) {
        menuMaxHeight = Math.max(spaceAbove - gap, 150);
        positionAbove = true;
      } else {
        menuMaxHeight = Math.max(spaceBelow - gap, 150);
        positionAbove = false;
      }
    }

    // Position below or above the button, aligned to the right
    let left = rect.right - menuWidth;
    let top = positionAbove
      ? rect.top - menuMaxHeight - gap
      : rect.bottom + gap;

    // Ensure menu doesn't go off left edge
    if (left < 8) {
      left = 8;
    }

    // Ensure menu doesn't go off right edge
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8;
    }

    return createPortal(
      <>
        {/* Backdrop - pointer-events-auto to capture clicks for closing */}
        <div
          className="fixed inset-0 z-[10002] pointer-events-auto"
          onClick={handleCloseMenu}
          style={{ background: "rgba(0, 0, 0, 0.3)" }}
        />

        {/* Menu - must be above backdrop with pointer-events-auto */}
        <div
          className="fixed z-[10003] bg-gray-900 border border-gray-700 rounded-lg shadow-xl pointer-events-auto"
          style={{
            left: `${left}px`,
            top: `${top}px`,
            width: `${menuWidth}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="overflow-y-scroll"
            style={{
              maxHeight: `${menuMaxHeight}px`,
              scrollbarWidth: "thin",
              scrollbarColor: "#4B5563 #1F2937",
            }}
            onWheel={(e) => e.stopPropagation()}
          >
            {availableForCategory.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500">
                No available {addingToCategory} points from your systems
              </div>
            ) : (
              (() => {
                // Group points by system
                const grouped = availableForCategory.reduce(
                  (acc, point) => {
                    const key = point.systemId;
                    if (!acc[key]) {
                      acc[key] = {
                        systemName: point.systemName,
                        points: [],
                      };
                    }
                    acc[key].points.push(point);
                    return acc;
                  },
                  {} as Record<
                    number,
                    { systemName: string; points: AvailablePoint[] }
                  >,
                );

                // Sort systems by name and points within each system by name
                return Object.entries(grouped)
                  .sort(([, a], [, b]) =>
                    a.systemName.localeCompare(b.systemName),
                  )
                  .map(([systemId, group]) => (
                    <div key={systemId}>
                      <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 bg-gray-800/50 sticky top-0">
                        {group.systemName}
                      </div>
                      {group.points
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((point, idx) => (
                          <button
                            key={idx}
                            onClick={(e) => {
                              e.stopPropagation();
                              // Keep menu open if shift, ctrl, or cmd key is pressed
                              const keepMenuOpen =
                                e.shiftKey || e.ctrlKey || e.metaKey;
                              handleSelectPoint(
                                addingToCategory,
                                point,
                                keepMenuOpen,
                              );
                            }}
                            className="w-full text-left pl-6 pr-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 transition-colors border-b border-gray-800 last:border-b-0"
                          >
                            <span>{point.name}</span>
                            <span className="ml-2 text-gray-600">
                              {point.path}
                            </span>
                            <span className="ml-2 text-gray-500">
                              {point.metricType}
                            </span>
                          </button>
                        ))}
                    </div>
                  ));
              })()
            )}
          </div>
        </div>
      </>,
      document.body,
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">Loading composite configuration...</div>
      </div>
    );
  }

  return (
    <div className="space-y-[15px]">
      <p className="text-sm text-gray-400">
        Map data points from your other systems to create a unified view.
      </p>

      {renderPopupMenu()}

      {Object.entries(CATEGORY_CONFIG).map(([category, config]) => {
        const currentMappings = mappings[category] || [];

        return (
          <div
            key={category}
            className={`border rounded-none sm:rounded-lg p-3 -mx-6 sm:mx-0 sm:flex sm:gap-4 ${config.bgColor} ${config.borderColor}`}
          >
            {/* Header Row - Mobile: Icon/Label/Button, Desktop: Just Icon/Label */}
            <div className="flex items-center justify-between mb-3 sm:mb-0 sm:flex-col sm:items-center sm:justify-start sm:min-w-[60px]">
              <div className="flex items-center gap-2 sm:flex-col sm:gap-1">
                <config.icon
                  className={`w-5 h-5 sm:w-8 sm:h-8 ${config.iconColor}`}
                />
                <h3 className="text-sm font-semibold text-gray-200 sm:text-center">
                  {config.label}
                </h3>
              </div>
              {/* Add Button - Visible on mobile */}
              <button
                onClick={(e) => handleAddMapping(category, e.currentTarget)}
                className="flex sm:hidden items-center gap-1 px-2 py-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-400/10 rounded transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add
              </button>
            </div>

            {/* Content - Right Side on Desktop */}
            <div className="flex-1 min-w-0">
              {/* Add Button - Desktop only */}
              <div className="hidden sm:flex justify-end mb-2">
                <button
                  onClick={(e) => handleAddMapping(category, e.currentTarget)}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-400/10 rounded transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              </div>

              {/* Existing Mappings */}
              {currentMappings.length > 0 ? (
                <div>
                  {currentMappings.map((pointId, index) => {
                    const labelParts = getDisplayLabelParts(pointId);
                    return (
                      <div
                        key={index}
                        className="flex items-center justify-between bg-gray-900/50 px-3 py-1.5 text-sm border-b border-gray-800 last:border-b-0"
                      >
                        <span className="text-gray-300">
                          {labelParts ? (
                            <>
                              <span className="font-semibold">
                                {labelParts.systemName}
                              </span>{" "}
                              <span className="text-gray-400">
                                {labelParts.pointName}
                              </span>
                              <span className="ml-2 text-gray-600">
                                {labelParts.path}
                              </span>
                              <span className="ml-2 text-gray-500">
                                {labelParts.metricType}
                              </span>
                            </>
                          ) : (
                            pointId
                          )}
                        </span>
                        <button
                          onClick={() => handleRemoveMapping(category, index)}
                          className="text-gray-500 hover:text-red-400 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-sm text-gray-500 italic">
                  No {category} data sources configured
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
