"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X, Shield } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import PointsTab from "./PointsTab";
import CompositeTab from "./CompositeTab";
import AdminTab from "./AdminTab";
import { TIMEZONE_GROUPS } from "@/lib/timezones";

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
  const [isLoading, setIsLoading] = useState(false);
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
  const [isAdminDirty, setIsAdminDirty] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  // Default system state
  const [isDefaultSystem, setIsDefaultSystem] = useState(false);
  const [originalIsDefault, setOriginalIsDefault] = useState(false);
  const [isDefaultDirty, setIsDefaultDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "general" | "points" | "composite" | "admin"
  >("general");
  const compositeSaveRef = useRef<(() => Promise<any>) | null>(null);
  const adminSaveRef = useRef<(() => Promise<any>) | null>(null);

  // Register this modal with the global modal context
  const { registerModal, unregisterModal } = useModalContext();
  useEffect(() => {
    if (isOpen) {
      registerModal("system-settings-dialog");
      return () => unregisterModal("system-settings-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  // Fetch settings when modal opens
  useEffect(() => {
    if (!isOpen || !systemId) {
      // Reset tab to general when modal closes (prevents flash on next open)
      if (!isOpen) {
        setActiveTab("general");
      }
      return;
    }

    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`/api/admin/systems/${systemId}/settings`);

        if (!response.ok) {
          throw new Error("Failed to fetch system settings");
        }

        const data = await response.json();

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
          setIsAdminDirty(false);
          setAliasError(null);
        }

        // Fetch user preferences to check if this is the default system
        const prefsResponse = await fetch("/api/user/preferences");
        if (prefsResponse.ok) {
          const prefsData = await prefsResponse.json();
          if (prefsData.success && prefsData.preferences) {
            const isCurrentDefault =
              prefsData.preferences.defaultSystemId === systemId;
            setIsDefaultSystem(isCurrentDefault);
            setOriginalIsDefault(isCurrentDefault);
            setIsDefaultDirty(false);
          }
        }
      } catch (error) {
        console.error("Error fetching system settings:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSettings();
  }, [isOpen, systemId]);

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
    isAdminDirty ||
    isDefaultDirty;
  const hasGeneralChanges =
    isDisplayNameDirty || isAliasDirty || isTimezoneDirty || isDefaultDirty;

  const handleSave = useCallback(async () => {
    if (!hasChanges || !systemId || aliasError) return;

    setIsSaving(true);
    try {
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

      // Prepare updates to pass to dashboard (before resetting dirty flags)
      const updates: { displayName?: string; alias?: string | null } = {};
      if (isDisplayNameDirty) updates.displayName = editedDisplayName;
      if (isAliasDirty) updates.alias = editedAlias || null;

      // Reset dirty flags
      setIsDisplayNameDirty(false);
      setIsAliasDirty(false);
      setIsTimezoneDirty(false);
      setIsCompositeDirty(false);
      setIsAdminDirty(false);
      setIsDefaultDirty(false);
      setOriginalIsDefault(isDefaultSystem);

      // Close modal
      onClose();

      // Call onUpdate to trigger dashboard data refresh and pass updated values for instant UI update
      if (onUpdate) {
        await onUpdate(updates);
      }
    } catch (error) {
      console.error("Failed to update system settings:", error);
      // Check if it's a uniqueness error
      if (error instanceof Error && error.message.includes("already in use")) {
        setAliasError(`Alias "${editedAlias}" is already in use`);
      }
    } finally {
      setIsSaving(false);
    }
  }, [
    hasChanges,
    systemId,
    aliasError,
    isDisplayNameDirty,
    isAliasDirty,
    isTimezoneDirty,
    editedDisplayName,
    editedAlias,
    editedTimezone,
    onUpdate,
    isCompositeDirty,
    isAdminDirty,
    isDefaultDirty,
    isDefaultSystem,
    onClose,
  ]);

  const handleCancel = useCallback(() => {
    setEditedDisplayName(displayName);
    setEditedAlias(alias);
    setEditedTimezone(displayTimezone);
    setIsDisplayNameDirty(false);
    setIsAliasDirty(false);
    setIsTimezoneDirty(false);
    setAliasError(null);
    onClose();
  }, [displayName, alias, displayTimezone, onClose]);

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
      if (e.key === "Escape") {
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
              className="p-1 hover:bg-gray-700 rounded transition-colors"
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
          <div className="px-6 py-4 border-t border-gray-700 flex justify-end gap-3">
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
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-w-[100px]"
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
