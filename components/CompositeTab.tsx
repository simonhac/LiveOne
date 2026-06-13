import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { Plus, X, Sun, Home, Battery, Zap, Car } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { useUser } from "@clerk/nextjs";
import { stemSplit } from "@/lib/identifiers/logical-path";
import { ROLE_IDS, ROLES, type RoleId } from "@/lib/roles/registry";

interface CompositeMapping {
  [key: string]: string[]; // Allow any category keys
}

interface AvailablePoint {
  id: string; // Format: "systemId.pointId"
  logicalPath: string; // Full logical path like "source.solar.local/power"
  pointName: string; // Display name
  systemId: number;
  systemName: string;
}

interface PointsResponse {
  success: boolean;
  availablePoints?: AvailablePoint[];
}

interface CompositeConfigResponse {
  success: boolean;
  metadata?: {
    mappings?: CompositeMapping;
  };
}

const EMPTY_MAPPINGS = (): CompositeMapping =>
  Object.fromEntries(
    ROLE_IDS.map((id) => [id, [] as string[]]),
  ) as CompositeMapping;

interface CompositeTabProps {
  systemId: number;
  shouldLoad?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onSaveFunctionReady?: (saveFunction: () => Promise<CompositeMapping>) => void;
  ownerUserId?: string; // Optional: owner user ID for fetching points (for new systems)
}

// Presentation (icon + colors) per role; labels come from the role registry. The category list,
// ordering, and labels are now sourced from lib/roles/registry.ts.
const ROLE_PRESENTATION: Record<
  RoleId,
  { icon: LucideIcon; iconColor: string; bgColor: string; borderColor: string }
> = {
  solar: {
    icon: Sun,
    iconColor: "text-yellow-400",
    bgColor: "bg-yellow-500/10",
    borderColor: "border-yellow-500/30",
  },
  battery: {
    icon: Battery,
    iconColor: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/30",
  },
  load: {
    icon: Home,
    iconColor: "text-red-400",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500/30",
  },
  grid: {
    icon: Zap,
    iconColor: "text-green-400",
    bgColor: "bg-green-500/10",
    borderColor: "border-green-500/30",
  },
  ev: {
    icon: Car,
    iconColor: "text-purple-400",
    bgColor: "bg-purple-500/10",
    borderColor: "border-purple-500/30",
  },
};

const CATEGORY_CONFIG = Object.fromEntries(
  ROLE_IDS.map((id) => [
    id,
    { label: ROLES[id].label, ...ROLE_PRESENTATION[id] },
  ]),
) as Record<
  RoleId,
  {
    label: string;
    icon: LucideIcon;
    iconColor: string;
    bgColor: string;
    borderColor: string;
  }
>;

export default function CompositeTab({
  systemId,
  shouldLoad = false,
  onDirtyChange,
  onSaveFunctionReady,
  ownerUserId,
}: CompositeTabProps) {
  const { user } = useUser();
  const [mappings, setMappings] = useState<CompositeMapping>(EMPTY_MAPPINGS);
  const [initialMappings, setInitialMappings] =
    useState<CompositeMapping>(EMPTY_MAPPINGS);
  const [addingToCategory, setAddingToCategory] = useState<string | null>(null);
  const [menuButtonRef, setMenuButtonRef] = useState<HTMLButtonElement | null>(
    null,
  );

  // Determine which user ID to use for fetching points
  // Priority: ownerUserId prop > current user ID
  const userId = ownerUserId || user?.id;

  // Fetch available points from user's systems
  const pointsQuery = useQuery({
    queryKey: ["composite", "available-points", userId],
    queryFn: () =>
      fetchJson<PointsResponse>(`/api/admin/user/${userId}/points`),
    enabled: shouldLoad && !!userId,
  });

  // For existing systems, fetch their composite configuration
  const configQuery = useQuery({
    queryKey: ["system", systemId, "composite-config"],
    queryFn: () =>
      fetchJson<CompositeConfigResponse>(
        `/api/admin/systems/${systemId}/composite-config`,
      ),
    enabled: shouldLoad && !!userId && systemId !== -1,
  });

  const availablePoints = useMemo<AvailablePoint[]>(
    () => pointsQuery.data?.availablePoints || [],
    [pointsQuery.data],
  );

  // Loading mirrors the original: points must resolve, and (for existing
  // systems) the config too. With no userId the original bailed out of loading.
  const loading = !userId
    ? false
    : pointsQuery.isPending || (systemId !== -1 && configQuery.isPending);

  // Seed editable mappings from the fetched config (replaces the in-fetch
  // seeding); re-seeds whenever fresh server data arrives.
  const pointsData = pointsQuery.data;
  const configData = configQuery.data;
  useEffect(() => {
    if (systemId === -1) {
      // For new systems, initialize with empty mappings (once points load)
      if (pointsData?.success) {
        const emptyMappings = EMPTY_MAPPINGS();
        setMappings(emptyMappings);
        setInitialMappings(JSON.parse(JSON.stringify(emptyMappings)));
      }
      return;
    }
    // For existing systems, seed from their composite configuration
    if (pointsData?.success && configData?.success) {
      const metadata = configData.metadata || {};
      const currentMappings: CompositeMapping =
        metadata.mappings || EMPTY_MAPPINGS();
      setMappings(currentMappings);
      setInitialMappings(JSON.parse(JSON.stringify(currentMappings)));
    }
  }, [systemId, pointsData, configData]);

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
    logicalPath: string;
  } | null => {
    const point = availablePoints.find((p) => p.id === pointId);

    if (point) {
      return {
        systemName: point.systemName,
        pointName: point.pointName,
        logicalPath: point.logicalPath,
      };
    }

    // Fallback: parse the ID - but we don't have logicalPath info
    const parts = pointId.split(".");
    if (parts.length !== 2) return null;

    return {
      systemName: `System ${parts[0]}`,
      pointName: `Point ${parts[1]}`,
      logicalPath: "",
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
    // Map UI categories to series ID path patterns, sourced from the role registry.
    const categoryPatterns: Record<string, string> = Object.fromEntries(
      ROLE_IDS.map((id) => [id, ROLES[id].stem]),
    );

    // Get already-added point IDs for this category
    const addedIds = new Set(mappings[category] || []);

    return availablePoints.filter((point) => {
      // Check if it matches the category pattern (if pattern exists)
      const pattern = categoryPatterns[category];
      if (pattern && !matchesPattern(point.logicalPath, pattern)) {
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
                        .sort((a, b) => a.pointName.localeCompare(b.pointName))
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
                            <span>{point.pointName}</span>
                            <span className="ml-2 text-gray-600">
                              {point.logicalPath}
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
                                {labelParts.logicalPath}
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
