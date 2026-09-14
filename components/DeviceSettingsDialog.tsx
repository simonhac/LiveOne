"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { X, Shield, Loader2, Layers } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import PointsTab from "./PointsTab";
import TeslaConfigTab from "./TeslaConfigTab";
import DeviceConfigTab from "./DeviceConfigTab";
import AdminTab from "./AdminTab";
import AreaBuilderDialog from "@/components/area-builder/AreaBuilderDialog";
/** `+600` / `-330`, the way the CLI prints an offset. */
const signedOffset = (m: number) => `${m >= 0 ? "+" : ""}${m}m`;

interface DeviceSettingsDialogProps {
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

export default function DeviceSettingsDialog({
  isOpen,
  onClose,
  systemId,
  vendorType,
  metadata,
  isAdmin = false,
  onUpdate,
}: DeviceSettingsDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [alias, setAlias] = useState("");
  const [editedDisplayName, setEditedDisplayName] = useState("");
  const [editedAlias, setEditedAlias] = useState("");
  const [isDisplayNameDirty, setIsDisplayNameDirty] = useState(false);
  const [isAliasDirty, setIsAliasDirty] = useState(false);
  const [isTeslaDirty, setIsTeslaDirty] = useState(false);
  const [isConfigDirty, setIsConfigDirty] = useState(false);
  const [isAdminDirty, setIsAdminDirty] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  // The DEVICE's own day bucket. Shown, never edited here: `point_readings_agg_1d` rolls up on it,
  // so changing it without rebuilding leaves every daily total the device ever produced describing
  // a window its own `day` key no longer matches. `liveone device change-offset` does both.
  const [dayOffsetMin, setDayOffsetMin] = useState<number | null>(null);
  const [showAreaBuilder, setShowAreaBuilder] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "general" | "points" | "tesla" | "config" | "admin"
  >("general");
  const teslaSaveRef = useRef<(() => Promise<any>) | null>(null);
  const configSaveRef = useRef<(() => Promise<any>) | null>(null);
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
          /** The device's own fixed day bucket, shown read-only. */
          dayOffsetMin?: number | null;
        };
      }>(`/api/admin/devices/${systemId}/settings`);

      return { settings };
    },
    enabled: isOpen && !!systemId,
  });

  const isLoading =
    isOpen && !!systemId && (isSettingsPending || isSettingsFetching);

  // Populate form state from fetched settings
  useEffect(() => {
    if (!settingsData) return;

    const { settings: data } = settingsData;

    if (data.success && data.settings) {
      const {
        displayName: fetchedName,
        alias: fetchedAlias,
        dayOffsetMin: fetchedDayOffset,
      } = data.settings;

      setDayOffsetMin(fetchedDayOffset ?? null);

      // Store original values
      setDisplayName(fetchedName || "");
      setAlias(fetchedAlias || "");

      // Initialize edited values
      setEditedDisplayName(fetchedName || "");
      setEditedAlias(fetchedAlias || "");

      // Reset dirty flags
      setIsDisplayNameDirty(false);
      setIsAliasDirty(false);
      setIsTeslaDirty(false);
      setIsConfigDirty(false);
      setIsAdminDirty(false);
      setAliasError(null);
    }
  }, [settingsData]);

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

  const hasChanges =
    isDisplayNameDirty ||
    isAliasDirty ||
    isTeslaDirty ||
    isConfigDirty ||
    isAdminDirty;
  const hasGeneralChanges = isDisplayNameDirty || isAliasDirty;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const startedAt = performance.now();

      // Save regular settings (displayName, alias)
      if (isDisplayNameDirty || isAliasDirty) {
        const settings: {
          displayName?: string;
          alias?: string | null;
        } = {};

        if (isDisplayNameDirty) settings.displayName = editedDisplayName;
        if (isAliasDirty) settings.alias = editedAlias || null;

        console.log("Settings to save:", settings);

        const response = await fetch(
          `/api/admin/devices/${systemId}/settings`,
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

      // Save Tesla config via the generic per-device metadata route
      if (isTeslaDirty && teslaSaveRef.current) {
        const teslaConfig = await teslaSaveRef.current();

        const response = await fetch(
          `/api/admin/devices/${systemId}/metadata`,
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

      // Save per-device config (capability overrides + nameplateKw + updateCadenceSeconds).
      if (isConfigDirty && configSaveRef.current) {
        const deviceConfig = await configSaveRef.current();

        const response = await fetch(`/api/admin/devices/${systemId}/config`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(deviceConfig),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error || "Failed to update device configuration",
          );
        }
      }

      // Save admin settings separately
      if (isAdminDirty && adminSaveRef.current) {
        const adminData = await adminSaveRef.current();

        console.log("Admin data to save:", adminData);

        const response = await fetch(
          `/api/admin/devices/${systemId}/admin-settings`,
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
      setIsTeslaDirty(false);
      setIsConfigDirty(false);
      setIsAdminDirty(false);

      // Refresh this dialog's settings query so a reopen shows the saved values
      queryClient.invalidateQueries({
        queryKey: ["system", systemId, "settings"],
      });
      // Config edits change capability eligibility + stale/sizing — refresh the config query and the
      // device's live dashboard data so open cards re-derive.
      queryClient.invalidateQueries({
        queryKey: ["system", systemId, "config"],
      });
      queryClient.invalidateQueries({
        queryKey: ["data", String(systemId)],
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
    setIsDisplayNameDirty(false);
    setIsAliasDirty(false);
    setAliasError(null);
    onClose();
  }, [displayName, alias, onClose]);

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
                onClick={() => setActiveTab("points")}
                className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                  activeTab === "points"
                    ? "text-white border-blue-500 bg-gray-700/50"
                    : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                Points
              </button>
              <button
                onClick={() => setActiveTab("config")}
                className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                  activeTab === "config"
                    ? "text-white border-blue-500 bg-gray-700/50"
                    : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                }`}
              >
                Capabilities
                {isConfigDirty && (
                  <span className="ml-2 inline-block w-2 h-2 bg-red-500 rounded-full"></span>
                )}
              </button>
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
                      all of the owner&apos;s devices, and contain only letters,
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

                  {/* The device's own day bucket — read-only. See `dayOffsetMin`'s comment. */}
                  {dayOffsetMin !== null && (
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-300 mb-2">
                        Day boundary
                      </label>
                      <p className="text-xs text-gray-400 mb-2">
                        This device&apos;s own fixed offset — the boundary its
                        daily totals roll up on. It does not change when the
                        device moves between sites.
                      </p>
                      <div className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-md text-gray-400 font-mono text-sm">
                        {signedOffset(dayOffsetMin)}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Changing it re-buckets every daily total the device has
                        ever produced, so it is a deliberate operation:{" "}
                        <code className="text-gray-400">
                          liveone device change-offset {systemId} --apply
                        </code>
                        .
                      </p>
                    </div>
                  )}

                  {/* Create a site (multi-device Area) seeded from this device */}
                  <div className="mt-4 border-t border-gray-700 pt-4">
                    <p className="mb-2 text-xs text-gray-500">
                      Combine this device with others into a “site” you can put
                      on a custom dashboard.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowAreaBuilder(true)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-600 px-3 py-2 text-sm text-gray-200 transition-colors hover:border-gray-500 hover:text-white"
                    >
                      <Layers className="w-4 h-4 text-purple-400" />
                      Create a site from this device
                    </button>
                  </div>
                </div>

                {/* Points Tab Content */}
                <div className={activeTab === "points" ? "" : "hidden"}>
                  <PointsTab systemId={systemId} shouldLoad={isOpen} />
                </div>

                {/* Capabilities / Config Tab Content */}
                <div className={activeTab === "config" ? "" : "hidden"}>
                  <DeviceConfigTab
                    systemId={systemId}
                    shouldLoad={isOpen}
                    onDirtyChange={setIsConfigDirty}
                    onSaveFunctionReady={(fn) => {
                      configSaveRef.current = fn;
                    }}
                  />
                </div>

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

      <AreaBuilderDialog
        isOpen={showAreaBuilder}
        areaId={null}
        initialMemberSystemId={systemId ?? undefined}
        onClose={() => setShowAreaBuilder(false)}
        onSaved={() => router.refresh()}
      />
    </>,
    document.body,
  );
}
