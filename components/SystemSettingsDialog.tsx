"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { X, Shield, Loader2, MapPin } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import PointsTab from "./PointsTab";
import CompositeTab from "./CompositeTab";
import TeslaConfigTab from "./TeslaConfigTab";
import AdminTab from "./AdminTab";
import { TIMEZONE_GROUPS } from "@/lib/timezones";
import {
  nemRegionForLocation,
  nemRegionShortLabel,
} from "@/lib/vendors/openelectricity/region";

// State/territory codes. WA/NT are valid locations but off the NEM (the preview says so).
const AU_STATES = [
  "NSW",
  "ACT",
  "VIC",
  "QLD",
  "SA",
  "TAS",
  "WA",
  "NT",
] as const;

interface SystemSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  systemId: number | null;
  vendorType?: string;
  metadata?: any;
  ownerClerkUserId?: string;
  isAdmin?: boolean;
  onUpdate?: (updates?: {
    displayName?: string;
    alias?: string | null;
  }) => Promise<void>;
}

export default function SystemSettingsDialog({
  isOpen,
  onClose,
  systemId,
  vendorType,
  metadata,
  ownerClerkUserId,
  isAdmin = false,
  onUpdate,
}: SystemSettingsDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [alias, setAlias] = useState("");
  const [displayTimezone, setDisplayTimezone] = useState("");
  const [editedDisplayName, setEditedDisplayName] = useState("");
  const [editedAlias, setEditedAlias] = useState("");
  const [editedTimezone, setEditedTimezone] = useState("");
  const [isDisplayNameDirty, setIsDisplayNameDirty] = useState(false);
  const [isAliasDirty, setIsAliasDirty] = useState(false);
  const [isTimezoneDirty, setIsTimezoneDirty] = useState(false);
  const [isCompositeDirty, setIsCompositeDirty] = useState(false);
  const [isTeslaDirty, setIsTeslaDirty] = useState(false);
  const [isAdminDirty, setIsAdminDirty] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  // Default system state
  const [isDefaultSystem, setIsDefaultSystem] = useState(false);
  const [originalIsDefault, setOriginalIsDefault] = useState(false);
  const [isDefaultDirty, setIsDefaultDirty] = useState(false);
  // Location (folded in from the former AreaLocationDialog) — sets the site's NEM region for the
  // Local Grid card. country is fixed to AU (the NEM is Australia-only).
  const [locationState, setLocationState] = useState("");
  const [locationPostcode, setLocationPostcode] = useState("");
  const [origLocationState, setOrigLocationState] = useState("");
  const [origLocationPostcode, setOrigLocationPostcode] = useState("");
  const [isLocationDirty, setIsLocationDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "general" | "points" | "composite" | "tesla" | "admin" | "location"
  >("general");
  const compositeSaveRef = useRef<(() => Promise<any>) | null>(null);
  const teslaSaveRef = useRef<(() => Promise<any>) | null>(null);
  const adminSaveRef = useRef<(() => Promise<any>) | null>(null);

  // Register this modal with the global modal context
  const { registerModal, unregisterModal } = useModalContext();
  useEffect(() => {
    if (isOpen) {
      registerModal("system-settings-dialog");
      return () => unregisterModal("system-settings-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  // Reset tab to general when modal closes (prevents flash on next open)
  useEffect(() => {
    if (!isOpen) {
      setActiveTab("general");
    }
  }, [isOpen]);

  // Fetch settings + user preferences when modal opens
  const {
    data: settingsData,
    isPending: isSettingsPending,
    isFetching: isSettingsFetching,
  } = useQuery({
    queryKey: ["system", systemId, "settings"],
    queryFn: async () => {
      const settings = await fetchJson<{
        success: boolean;
        settings?: {
          displayName?: string | null;
          alias?: string | null;
          displayTimezone?: string | null;
        };
      }>(`/api/admin/systems/${systemId}/settings`);

      // Fetch user preferences to check if this is the default system
      let isCurrentDefault = false;
      try {
        const prefs = await fetchJson<{
          success: boolean;
          preferences?: { defaultSystemId?: number | null };
        }>("/api/user/preferences");
        if (prefs.success && prefs.preferences) {
          isCurrentDefault = prefs.preferences.defaultSystemId === systemId;
        }
      } catch (error) {
        console.error("Error fetching user preferences:", error);
      }

      return { settings, isCurrentDefault };
    },
    enabled: isOpen && !!systemId,
  });

  const isLoading =
    isOpen && !!systemId && (isSettingsPending || isSettingsFetching);

  // Populate form state from fetched settings
  useEffect(() => {
    if (!settingsData) return;

    const { settings: data, isCurrentDefault } = settingsData;

    if (data.success && data.settings) {
      const {
        displayName: fetchedName,
        alias: fetchedAlias,
        displayTimezone: fetchedTimezone,
      } = data.settings;

      // Store original values
      setDisplayName(fetchedName || "");
      setAlias(fetchedAlias || "");
      setDisplayTimezone(fetchedTimezone || "");

      // Initialize edited values
      setEditedDisplayName(fetchedName || "");
      setEditedAlias(fetchedAlias || "");
      setEditedTimezone(fetchedTimezone || "");

      // Reset dirty flags
      setIsDisplayNameDirty(false);
      setIsAliasDirty(false);
      setIsTimezoneDirty(false);
      setIsCompositeDirty(false);
      setIsTeslaDirty(false);
      setIsAdminDirty(false);
      setAliasError(null);
    }

    setIsDefaultSystem(isCurrentDefault);
    setOriginalIsDefault(isCurrentDefault);
    setIsDefaultDirty(false);
  }, [settingsData]);

  // Fetch the site's location when the dialog opens (separate from the admin settings query).
  const { data: locationData } = useQuery({
    queryKey: ["system", systemId, "location"],
    queryFn: () =>
      fetchJson<{
        location?: { state?: string | null; postcode?: string | null };
      }>(`/api/systems/${systemId}/location`),
    enabled: isOpen && !!systemId,
  });

  useEffect(() => {
    if (!locationData) return;
    const st = locationData.location?.state ?? "";
    const pc = locationData.location?.postcode ?? "";
    setLocationState(st);
    setLocationPostcode(pc);
    setOrigLocationState(st);
    setOrigLocationPostcode(pc);
    setIsLocationDirty(false);
  }, [locationData]);

  // Live region preview from the current form — same derivation the server uses.
  const locationRegion = nemRegionForLocation({
    country: "AU",
    state: locationState || undefined,
    postcode: locationPostcode || undefined,
  });

  const validateAlias = (value: string): string | null => {
    if (!value) return null; // Empty is valid (optional field)
    if (!/^[a-zA-Z0-9_]+$/.test(value)) {
      return "Only letters, digits, and underscores are allowed";
    }
    if (/^\d+$/.test(value)) {
      return "Must contain at least one non-numeric character";
    }
    return null;
  };

  const handleDisplayNameChange = (value: string) => {
    setEditedDisplayName(value);
    setIsDisplayNameDirty(value !== displayName);
  };

  const handleAliasChange = (value: string) => {
    setEditedAlias(value);
    setIsAliasDirty(value !== alias);
    setAliasError(validateAlias(value));
  };

  const handleTimezoneChange = (value: string) => {
    setEditedTimezone(value);
    setIsTimezoneDirty(value !== displayTimezone);
  };

  const hasChanges =
    isDisplayNameDirty ||
    isAliasDirty ||
    isTimezoneDirty ||
    isCompositeDirty ||
    isTeslaDirty ||
    isAdminDirty ||
    isDefaultDirty ||
    isLocationDirty;
  const hasGeneralChanges =
    isDisplayNameDirty || isAliasDirty || isTimezoneDirty || isDefaultDirty;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const startedAt = performance.now();

      // Save regular settings (displayName, alias, displayTimezone)
      if (isDisplayNameDirty || isAliasDirty || isTimezoneDirty) {
        const settings: {
          displayName?: string;
          alias?: string | null;
          displayTimezone?: string | null;
        } = {};

        if (isDisplayNameDirty) settings.displayName = editedDisplayName;
        if (isAliasDirty) settings.alias = editedAlias || null;
        if (isTimezoneDirty) settings.displayTimezone = editedTimezone || null;

        console.log("Settings to save:", settings);

        const response = await fetch(
          `/api/admin/systems/${systemId}/settings`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(settings),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to update system settings");
        }
      }

      // Save composite configuration separately
      if (isCompositeDirty && compositeSaveRef.current) {
        const compositeMappings = await compositeSaveRef.current();

        console.log("Composite mappings to save:", compositeMappings);

        const response = await fetch(
          `/api/admin/systems/${systemId}/composite-config`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ mappings: compositeMappings }),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error || "Failed to update composite configuration",
          );
        }
      }

      // Save Tesla config via the generic per-system metadata route
      if (isTeslaDirty && teslaSaveRef.current) {
        const teslaConfig = await teslaSaveRef.current();

        const response = await fetch(
          `/api/admin/systems/${systemId}/metadata`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ key: "tesla", value: teslaConfig }),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to update Tesla configuration");
        }
      }

      // Save admin settings separately
      if (isAdminDirty && adminSaveRef.current) {
        const adminData = await adminSaveRef.current();

        console.log("Admin data to save:", adminData);

        const response = await fetch(
          `/api/admin/systems/${systemId}/admin-settings`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(adminData),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to update admin settings");
        }
      }

      // Save default system preference
      if (isDefaultDirty) {
        const response = await fetch("/api/user/preferences", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            defaultSystemId: isDefaultSystem ? systemId : null,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Failed to update default system");
        }
      }

      // Save the site's location (state + optional postcode → NEM region for the Local Grid card).
      // "" clears the field (see mergeAreaLocation). country is AU for the NEM.
      if (isLocationDirty) {
        const response = await fetch(`/api/systems/${systemId}/location`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            country: "AU",
            state: locationState || "",
            postcode: locationPostcode.trim() || "",
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Failed to update location");
        }
      }

      // Prepare updates to pass to dashboard (before resetting dirty flags)
      const updates: { displayName?: string; alias?: string | null } = {};
      if (isDisplayNameDirty) updates.displayName = editedDisplayName;
      if (isAliasDirty) updates.alias = editedAlias || null;

      // Floor the perceived save at 500ms so a near-instant save shows a real spinner
      // instead of an imperceptible flash. Log the actual (pre-floor) save time.
      const elapsed = performance.now() - startedAt;
      console.log(`[SystemSettings] Save took ${Math.round(elapsed)}ms`);
      if (elapsed < 500) {
        await new Promise((resolve) => setTimeout(resolve, 500 - elapsed));
      }

      return updates;
    },
    onSuccess: async (updates) => {
      // Reset dirty flags
      setIsDisplayNameDirty(false);
      setIsAliasDirty(false);
      setIsTimezoneDirty(false);
      setIsCompositeDirty(false);
      setIsTeslaDirty(false);
      setIsAdminDirty(false);
      setIsDefaultDirty(false);
      setOriginalIsDefault(isDefaultSystem);
      setIsLocationDirty(false);
      setOrigLocationState(locationState);
      setOrigLocationPostcode(locationPostcode);

      // Refresh this dialog's settings query so a reopen shows the saved values
      queryClient.invalidateQueries({
        queryKey: ["system", systemId, "settings"],
      });
      queryClient.invalidateQueries({
        queryKey: ["system", systemId, "location"],
      });

      // Close modal
      onClose();

      // Call onUpdate to trigger dashboard data refresh and pass updated values for instant UI update
      if (onUpdate) {
        await onUpdate(updates);
      }
    },
    onError: (error) => {
      console.error("Failed to update system settings:", error);
      // Check if it's a uniqueness error
      if (error instanceof Error && error.message.includes("already in use")) {
        setAliasError(`Alias "${editedAlias}" is already in use`);
      }
    },
  });

  const isSaving = saveMutation.isPending;

  const handleSave = useCallback(() => {
    if (!hasChanges || !systemId || aliasError) return;
    saveMutation.mutate();
  }, [hasChanges, systemId, aliasError, saveMutation]);

  const handleCancel = useCallback(() => {
    setEditedDisplayName(displayName);
    setEditedAlias(alias);
    setEditedTimezone(displayTimezone);
    setIsDisplayNameDirty(false);
    setIsAliasDirty(false);
    setIsTimezoneDirty(false);
    setLocationState(origLocationState);
    setLocationPostcode(origLocationPostcode);
    setIsLocationDirty(false);
    setAliasError(null);
    onClose();
  }, [
    displayName,
    alias,
    displayTimezone,
    origLocationState,
    origLocationPostcode,
    onClose,
  ]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (!isOpen) return;

    // Save original overflow value
    const originalOverflow = document.body.style.overflow;

    // Prevent body scroll
    document.body.style.overflow = "hidden";

    // Restore on cleanup
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  // Handle keyboard shortcuts globally when modal is open
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSaving) {
        e.preventDefault();
        handleCancel();
      } else if (e.key === "Enter" && hasChanges && !isSaving && !aliasError) {
        e.preventDefault();
        handleSave();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, hasChanges, isSaving, aliasError, handleCancel, handleSave]);

  if (!isOpen || !systemId || typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* Backdrop with blur */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]" />

      {/* Dialog */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[10001] w-full max-w-[488px] sm:max-w-[588px]">
        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <h2 className="text-lg font-medium text-gray-100">
              {isLoading ? "Loading..." : `${displayName} Settings`}
            </h2>
            <button
              onClick={onClose}
              disabled={isSaving}
              className="p-1 hover:bg-gray-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-700">
            <div className="flex items-end -mb-px px-6">
              <button
                onClick={() => setActiveTab("general")}
                className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                  activeTab === "general"
                    ? "text-white border-blue-500 bg-gray-700/50"
                    : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                General
                {hasGeneralChanges && (
                  <span className="ml-2 inline-block w-2 h-2 bg-red-500 rounded-full"></span>
                )}
              </button>
              <button
                onClick={() => setActiveTab("location")}
                className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                  activeTab === "location"
                    ? "text-white border-blue-500 bg-gray-700/50"
                    : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                Location
                {isLocationDirty && (
                  <span className="ml-2 inline-block w-2 h-2 bg-red-500 rounded-full"></span>
                )}
              </button>
              {vendorType !== "composite" && (
                <button
                  onClick={() => setActiveTab("points")}
                  className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                    activeTab === "points"
                      ? "text-white border-blue-500 bg-gray-700/50"
                      : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                  }`}
                >
                  Points
                </button>
              )}
              {vendorType === "composite" && (
                <button
                  onClick={() => setActiveTab("composite")}
                  className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                    activeTab === "composite"
                      ? "text-white border-blue-500 bg-gray-700/50"
                      : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                  }`}
                >
                  Composite
                  {isCompositeDirty && (
                    <span className="ml-2 inline-block w-2 h-2 bg-red-500 rounded-full"></span>
                  )}
                </button>
              )}
              {vendorType === "tesla" && (
                <button
                  onClick={() => setActiveTab("tesla")}
                  className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                    activeTab === "tesla"
                      ? "text-white border-blue-500 bg-gray-700/50"
                      : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                  }`}
                >
                  Tesla
                  {isTeslaDirty && (
                    <span className="ml-2 inline-block w-2 h-2 bg-red-500 rounded-full"></span>
                  )}
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={() => setActiveTab("admin")}
                  className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 flex items-center gap-2 ${
                    activeTab === "admin"
                      ? "text-white border-blue-500 bg-gray-700/50"
                      : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                  }`}
                >
                  <Shield className="w-4 h-4 text-blue-500" />
                  Admin
                  {isAdminDirty && (
                    <span className="ml-2 inline-block w-2 h-2 bg-red-500 rounded-full"></span>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="px-6 py-4 space-y-4 min-h-[500px] max-h-[500px] overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-gray-400">Loading settings...</div>
              </div>
            ) : (
              <>
                {/* General Tab Content */}
                <div className={activeTab === "general" ? "" : "hidden"}>
                  {/* Name field */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Display Name
                    </label>
                    <input
                      type="text"
                      value={editedDisplayName}
                      onChange={(e) => handleDisplayNameChange(e.target.value)}
                      onBlur={(e) => {
                        const withoutTrailingSpaces = e.target.value.replace(
                          /\s+$/,
                          "",
                        );
                        if (withoutTrailingSpaces !== e.target.value) {
                          handleDisplayNameChange(withoutTrailingSpaces);
                        }
                      }}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      disabled={isSaving}
                    />
                  </div>

                  {/* Short Name field */}
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Alias (optional)
                    </label>
                    <p className="text-xs text-gray-400 mb-2">
                      Used as an alias in URLs. Aliases must be unique across
                      all of the owner&apos;s systems, and contain only letters,
                      digits, and underscores and at least one non-numeric
                      character.
                    </p>
                    <input
                      type="text"
                      value={editedAlias}
                      onChange={(e) => handleAliasChange(e.target.value)}
                      placeholder="e.g., racv_kinkora"
                      className={`w-full px-3 py-2 bg-gray-900 border ${
                        aliasError ? "border-red-500" : "border-gray-700"
                      } rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                      disabled={isSaving}
                    />
                    {aliasError && (
                      <p className="text-xs text-red-400 mt-1">{aliasError}</p>
                    )}
                  </div>

                  {/* Display Timezone field */}
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Display Timezone
                    </label>
                    <p className="text-xs text-gray-400 mb-2">
                      Timezone used for all date/time displayed to users.
                    </p>
                    <select
                      value={editedTimezone || ""}
                      onChange={(e) => handleTimezoneChange(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      disabled={isSaving}
                    >
                      {!editedTimezone && (
                        <option value="">Select a timezone...</option>
                      )}
                      {TIMEZONE_GROUPS.map((group) => (
                        <optgroup key={group.region} label={group.region}>
                          {group.timezones.map((tz) => (
                            <option key={tz.value} value={tz.value}>
                              {tz.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>

                  {/* Default System Toggle */}
                  <div className="mt-6 pt-4 border-t border-gray-700">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isDefaultSystem}
                        onChange={(e) => {
                          setIsDefaultSystem(e.target.checked);
                          setIsDefaultDirty(
                            e.target.checked !== originalIsDefault,
                          );
                        }}
                        className="w-5 h-5 rounded border-gray-600 bg-gray-900 text-blue-600 focus:ring-blue-500 focus:ring-offset-gray-800"
                        disabled={isSaving}
                      />
                      <div>
                        <span className="text-sm font-medium text-gray-300">
                          Set as my default system
                        </span>
                        <p className="text-xs text-gray-400 mt-0.5">
                          This system will open automatically when you visit the
                          dashboard
                        </p>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Location Tab Content */}
                <div className={activeTab === "location" ? "" : "hidden"}>
                  <p className="text-sm text-gray-400 mb-4">
                    Your site&apos;s state sets the National Electricity Market
                    (NEM) region used by the Local Grid card (price, emissions,
                    renewables).
                  </p>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      State / territory
                    </label>
                    <select
                      value={locationState}
                      onChange={(e) => {
                        setLocationState(e.target.value);
                        setIsLocationDirty(
                          e.target.value !== origLocationState ||
                            locationPostcode !== origLocationPostcode,
                        );
                      }}
                      disabled={isSaving}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <option value="">Not set</option>
                      {AU_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Postcode (optional)
                    </label>
                    <p className="text-xs text-gray-400 mb-2">
                      Used only if no state is set.
                    </p>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={locationPostcode}
                      maxLength={4}
                      onChange={(e) => {
                        const pc = e.target.value.replace(/[^\d]/g, "");
                        setLocationPostcode(pc);
                        setIsLocationDirty(
                          locationState !== origLocationState ||
                            pc !== origLocationPostcode,
                        );
                      }}
                      placeholder="e.g. 3000"
                      disabled={isSaving}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  {/* Live region preview */}
                  <div className="mt-4 rounded-lg bg-gray-900/70 px-4 py-3 ring-1 ring-gray-700/80">
                    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                      <MapPin className="w-3.5 h-3.5" />
                      Grid region
                    </div>
                    <p className="mt-0.5 text-sm">
                      {locationRegion ? (
                        <span className="font-semibold text-blue-300">
                          {nemRegionShortLabel(locationRegion)} (
                          {locationRegion})
                        </span>
                      ) : (
                        <span className="text-gray-400">
                          Not on the NEM — no grid card
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Points Tab Content - Only for non-composite systems */}
                {vendorType !== "composite" && (
                  <div className={activeTab === "points" ? "" : "hidden"}>
                    <PointsTab systemId={systemId} shouldLoad={isOpen} />
                  </div>
                )}

                {/* Composite Tab Content */}
                {vendorType === "composite" && (
                  <div className={activeTab === "composite" ? "" : "hidden"}>
                    <CompositeTab
                      systemId={systemId}
                      shouldLoad={isOpen}
                      onDirtyChange={setIsCompositeDirty}
                      onSaveFunctionReady={(fn) => {
                        compositeSaveRef.current = fn;
                      }}
                      ownerUserId={ownerClerkUserId}
                    />
                  </div>
                )}

                {/* Tesla Tab Content */}
                {vendorType === "tesla" && (
                  <div className={activeTab === "tesla" ? "" : "hidden"}>
                    <TeslaConfigTab
                      systemId={systemId}
                      shouldLoad={isOpen}
                      onDirtyChange={setIsTeslaDirty}
                      onSaveFunctionReady={(fn) => {
                        teslaSaveRef.current = fn;
                      }}
                    />
                  </div>
                )}

                {/* Admin Tab Content */}
                {isAdmin && (
                  <div className={activeTab === "admin" ? "" : "hidden"}>
                    <AdminTab
                      systemId={systemId}
                      shouldLoad={isOpen}
                      onDirtyChange={setIsAdminDirty}
                      onSaveFunctionReady={(fn) => {
                        adminSaveRef.current = fn;
                      }}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
            <p className="text-sm text-red-400 min-w-0 truncate">
              {saveMutation.isError && !aliasError
                ? saveMutation.error instanceof Error
                  ? saveMutation.error.message
                  : "Failed to save"
                : ""}
            </p>
            <div className="flex gap-3 shrink-0">
              <button
                onClick={handleCancel}
                className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 rounded-md transition-colors min-w-[100px]"
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!hasChanges || isSaving || !!aliasError}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-w-[100px] flex items-center justify-center gap-2"
              >
                {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
