import { useState, useEffect, useMemo, useRef } from "react";
import { Plus, X, Sun, Home, Battery, Zap } from "lucide-react";
import { createPortal } from "react-dom";

interface CompositeMapping {
  solar: string[];
  battery: string[];
  load: string[];
  grid: string[];
}

interface AvailableCapability {
  systemId: number;
  systemName: string;
  shortName: string | null;
  seriesId: string;
  label: string;
}

interface CompositeTabProps {
  systemId: number;
  shouldLoad?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onSaveFunctionReady?: (saveFunction: () => Promise<CompositeMapping>) => void;
}

const CATEGORY_CONFIG = {
  solar: {
    label: "Solar",
    icon: Sun,
    iconColor: "text-yellow-400",
    maxEntries: null,
    bgColor: "bg-yellow-500/10",
    borderColor: "border-yellow-500/30",
  },
  battery: {
    label: "Battery",
    icon: Battery,
    iconColor: "text-blue-400",
    maxEntries: 1,
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/30",
  },
  load: {
    label: "Load",
    icon: Home,
    iconColor: "text-red-400",
    maxEntries: null,
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500/30",
  },
  grid: {
    label: "Grid",
    icon: Zap,
    iconColor: "text-green-400",
    maxEntries: 1,
    bgColor: "bg-green-500/10",
    borderColor: "border-green-500/30",
  },
};

export default function CompositeTab({
  systemId,
  shouldLoad = false,
  onDirtyChange,
  onSaveFunctionReady,
}: CompositeTabProps) {
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
  const [availableCapabilities, setAvailableCapabilities] = useState<
    AvailableCapability[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [addingToCategory, setAddingToCategory] = useState<string | null>(null);
  const [menuButtonRef, setMenuButtonRef] = useState<HTMLButtonElement | null>(
    null,
  );
  const fetchingRef = useRef(false);

  // Reset hasLoaded when modal closes
  useEffect(() => {
    if (!shouldLoad && hasLoaded) {
      setHasLoaded(false);
      setLoading(true);
      fetchingRef.current = false;
    }
  }, [shouldLoad, hasLoaded]);

  useEffect(() => {
    if (shouldLoad && !hasLoaded && !fetchingRef.current) {
      fetchCompositeConfig();
    }
  }, [systemId, shouldLoad, hasLoaded]);

  const fetchCompositeConfig = async () => {
    fetchingRef.current = true;
    try {
      // For new systems (systemId=-1), initialize with empty mappings
      // and fetch available capabilities from all systems
      if (systemId === -1) {
        // Fetch available capabilities from all systems
        const response = await fetch(
          "/api/admin/systems/composite-capabilities",
        );
        const data = await response.json();

        if (data.success) {
          const emptyMappings: CompositeMapping = {
            solar: [],
            battery: [],
            load: [],
            grid: [],
          };

          setMappings(emptyMappings);
          setInitialMappings(JSON.parse(JSON.stringify(emptyMappings)));
          setAvailableCapabilities(data.availableCapabilities || []);
          setHasLoaded(true);
        }
      } else {
        // For existing systems, fetch their composite configuration
        const response = await fetch(
          `/api/admin/systems/${systemId}/composite-config`,
        );
        const data = await response.json();

        if (data.success) {
          // Parse existing mappings from metadata
          const metadata = data.metadata || {};
          const currentMappings: CompositeMapping = {
            solar: metadata.mappings?.solar || [],
            battery: metadata.mappings?.battery || [],
            load: metadata.mappings?.load || [],
            grid: metadata.mappings?.grid || [],
          };

          setMappings(currentMappings);
          setInitialMappings(JSON.parse(JSON.stringify(currentMappings)));
          setAvailableCapabilities(data.availableCapabilities);
          setHasLoaded(true);
        }
      }
    } catch (error) {
      console.error("Failed to fetch composite config:", error);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  };

  // Check if mappings are dirty
  const isDirty = useMemo(() => {
    return JSON.stringify(mappings) !== JSON.stringify(initialMappings);
  }, [mappings, initialMappings]);

  // Notify parent when dirty state changes
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Provide save function to parent
  const getMappingsData = async (): Promise<CompositeMapping> => {
    return mappings;
  };

  useEffect(() => {
    onSaveFunctionReady?.(getMappingsData);
  }, [mappings, onSaveFunctionReady]);

  // Helper to build full path from capability
  const buildFullPath = (cap: AvailableCapability): string => {
    const systemPath = cap.shortName || `system.${cap.systemId}`;
    return `liveone.${systemPath}.${cap.seriesId}`;
  };

  // Helper to parse full path back to components
  const parseFullPath = (
    fullPath: string,
  ): { systemPath: string; seriesId: string } | null => {
    const parts = fullPath.split(".");
    if (parts.length < 3 || parts[0] !== "liveone") return null;

    // Check if systemPath is "system.{id}" (2 parts) or just a shortname (1 part)
    let systemPath: string;
    let seriesIdStartIndex: number;

    if (parts[1] === "system") {
      // Format: liveone.system.{id}.{seriesId}
      systemPath = `${parts[1]}.${parts[2]}`;
      seriesIdStartIndex = 3;
    } else {
      // Format: liveone.{shortname}.{seriesId}
      systemPath = parts[1];
      seriesIdStartIndex = 2;
    }

    const seriesId = parts.slice(seriesIdStartIndex).join(".");

    return { systemPath, seriesId };
  };

  // Get display label components for a full path
  const getDisplayLabelParts = (
    fullPath: string,
  ): { systemName: string; seriesId: string } | null => {
    const parsed = parseFullPath(fullPath);
    if (!parsed) return null;

    const cap = availableCapabilities.find(
      (c) =>
        (c.shortName === parsed.systemPath ||
          `system.${c.systemId}` === parsed.systemPath) &&
        c.seriesId === parsed.seriesId,
    );

    if (cap) {
      return { systemName: cap.systemName, seriesId: cap.seriesId };
    }

    // Fallback: format the path nicely
    const systemName = parsed.systemPath.startsWith("system.")
      ? `System ${parsed.systemPath.split(".")[1]}`
      : parsed.systemPath;
    return { systemName, seriesId: parsed.seriesId };
  };

  const handleAddMapping = (
    category: keyof CompositeMapping,
    buttonElement: HTMLButtonElement,
  ) => {
    const config = CATEGORY_CONFIG[category];
    if (config.maxEntries && mappings[category].length >= config.maxEntries) {
      return; // Already at max
    }
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

  const handleSelectCapability = (
    category: keyof CompositeMapping,
    capability: AvailableCapability,
  ) => {
    const fullPath = buildFullPath(capability);
    setMappings((prev) => ({
      ...prev,
      [category]: [...prev[category], fullPath],
    }));
    handleCloseMenu();
  };

  const handleRemoveMapping = (
    category: keyof CompositeMapping,
    index: number,
  ) => {
    setMappings((prev) => ({
      ...prev,
      [category]: prev[category].filter((_, i) => i !== index),
    }));
  };

  // Filter available capabilities for selection
  const getAvailableForCategory = (
    category: keyof CompositeMapping,
  ): AvailableCapability[] => {
    // Map UI categories to actual capability patterns
    const categoryPatterns: Record<
      keyof CompositeMapping,
      (seriesId: string) => boolean
    > = {
      solar: (id) => id.startsWith("source.solar"),
      battery: (id) =>
        id === "bidi.battery" ||
        id.startsWith("bidi.battery.") ||
        id === "battery" ||
        id.startsWith("battery."),
      load: (id) => id === "load" || id.startsWith("load."),
      grid: (id) =>
        id === "bidi.grid" ||
        id.startsWith("bidi.grid.") ||
        id === "grid" ||
        id.startsWith("grid."),
    };

    // Get already-added full paths for this category
    const addedPaths = new Set(mappings[category]);

    return availableCapabilities.filter((cap) => {
      // Check if it matches the category pattern
      if (!categoryPatterns[category](cap.seriesId)) {
        return false;
      }

      // Build the full path for this capability
      const systemPath = cap.shortName || `system.${cap.systemId}`;
      const fullPath = `liveone.${systemPath}.${cap.seriesId}`;

      // Exclude if already added to this category
      return !addedPaths.has(fullPath);
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
    const typedCategory = addingToCategory as keyof CompositeMapping;
    const availableForCategory = getAvailableForCategory(typedCategory);

    // Calculate position
    const rect = menuButtonRef.getBoundingClientRect();
    const menuWidth = 320;
    const menuMaxHeight = 300;

    // Position below the button, aligned to the right
    let left = rect.right - menuWidth;
    let top = rect.bottom + 4;

    // Ensure menu doesn't go off left edge
    if (left < 8) {
      left = 8;
    }

    // Ensure menu doesn't go off right edge
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8;
    }

    // Ensure menu doesn't go off bottom edge
    if (top + menuMaxHeight > window.innerHeight - 8) {
      // Position above the button instead
      top = rect.top - menuMaxHeight - 4;
      // If still off screen, position at top of viewport
      if (top < 8) {
        top = 8;
      }
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
          className="fixed z-[10003] bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden pointer-events-auto"
          style={{
            left: `${left}px`,
            top: `${top}px`,
            width: `${menuWidth}px`,
            maxHeight: `${menuMaxHeight}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="overflow-y-auto max-h-full">
            {availableForCategory.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500">
                No available {addingToCategory} capabilities from your systems
              </div>
            ) : (
              (() => {
                // Group capabilities by system
                const grouped = availableForCategory.reduce(
                  (acc, cap) => {
                    const key = cap.systemId;
                    if (!acc[key]) {
                      acc[key] = {
                        systemName: cap.systemName,
                        capabilities: [],
                      };
                    }
                    acc[key].capabilities.push(cap);
                    return acc;
                  },
                  {} as Record<
                    number,
                    { systemName: string; capabilities: AvailableCapability[] }
                  >,
                );

                return Object.entries(grouped).map(([systemId, group]) => (
                  <div key={systemId}>
                    <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 bg-gray-800/50 sticky top-0">
                      {group.systemName}
                    </div>
                    {group.capabilities.map((cap, idx) => (
                      <button
                        key={idx}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectCapability(typedCategory, cap);
                        }}
                        className="w-full text-left pl-6 pr-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 transition-colors border-b border-gray-800 last:border-b-0"
                      >
                        {cap.seriesId}
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
        const typedCategory = category as keyof CompositeMapping;
        const currentMappings = mappings[typedCategory];
        const canAdd =
          !config.maxEntries || currentMappings.length < config.maxEntries;

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
                <div className="flex items-center gap-2 sm:flex-col sm:gap-1">
                  <h3 className="text-sm font-semibold text-gray-200 sm:text-center">
                    {config.label}
                  </h3>
                  {config.maxEntries && (
                    <span className="text-xs text-gray-500 sm:text-center">
                      (one only)
                    </span>
                  )}
                </div>
              </div>
              {/* Add Button - Visible on mobile */}
              {canAdd && (
                <button
                  onClick={(e) =>
                    handleAddMapping(typedCategory, e.currentTarget)
                  }
                  className="flex sm:hidden items-center gap-1 px-2 py-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-400/10 rounded transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              )}
            </div>

            {/* Content - Right Side on Desktop */}
            <div className="flex-1 min-w-0">
              {/* Add Button - Desktop only */}
              <div className="hidden sm:flex justify-end mb-2">
                {canAdd && (
                  <button
                    onClick={(e) =>
                      handleAddMapping(typedCategory, e.currentTarget)
                    }
                    className="flex items-center gap-1 px-2 py-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-400/10 rounded transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    Add
                  </button>
                )}
              </div>

              {/* Existing Mappings */}
              {currentMappings.length > 0 ? (
                <div>
                  {currentMappings.map((fullPath, index) => {
                    const labelParts = getDisplayLabelParts(fullPath);
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
                                {labelParts.seriesId}
                              </span>
                            </>
                          ) : (
                            fullPath
                          )}
                        </span>
                        <button
                          onClick={() =>
                            handleRemoveMapping(typedCategory, index)
                          }
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
