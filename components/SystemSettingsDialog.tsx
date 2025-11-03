"use client";

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X, Shield } from "lucide-react";
import CapabilitiesTab from "./CapabilitiesTab";
import CompositeTab from "./CompositeTab";
import AdminTab from "./AdminTab";

interface SystemSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  system: {
    systemId: number;
    displayName: string;
    shortName: string | null;
    vendorType: string;
    metadata?: any;
  } | null;
  isAdmin?: boolean;
  onUpdate?: (
    systemId: number,
    updates: { displayName?: string; shortName?: string | null },
  ) => Promise<void>;
}

export default function SystemSettingsDialog({
  isOpen,
  onClose,
  system,
  isAdmin = false,
  onUpdate,
}: SystemSettingsDialogProps) {
  const router = useRouter();
  const [editedName, setEditedName] = useState(system?.displayName || "");
  const [editedShortName, setEditedShortName] = useState(
    system?.shortName || "",
  );
  const [isNameDirty, setIsNameDirty] = useState(false);
  const [isShortNameDirty, setIsShortNameDirty] = useState(false);
  const [isCompositeDirty, setIsCompositeDirty] = useState(false);
  const [isAdminDirty, setIsAdminDirty] = useState(false);
  const [shortNameError, setShortNameError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "general" | "capabilities" | "composite" | "admin"
  >("general");
  const compositeSaveRef = useRef<(() => Promise<any>) | null>(null);
  const adminSaveRef = useRef<(() => Promise<any>) | null>(null);

  // Reset form when modal opens or system ID changes (but not when system data updates)
  useEffect(() => {
    if (isOpen) {
      // Initialize form with current system data
      setEditedName(system?.displayName || "");
      setEditedShortName(system?.shortName || "");
      setIsNameDirty(false);
      setIsShortNameDirty(false);
      setIsCompositeDirty(false);
      setIsAdminDirty(false);
      setShortNameError(null);
    } else {
      // Reset tab to general when modal closes (prevents flash on next open)
      setActiveTab("general");
    }
  }, [isOpen, system?.systemId]); // Only depend on isOpen and systemId, not entire system object

  const validateShortName = (value: string): string | null => {
    if (!value) return null; // Empty is valid (optional field)
    if (!/^[a-zA-Z0-9_]+$/.test(value)) {
      return "Only letters, digits, and underscores are allowed";
    }
    if (/^\d+$/.test(value)) {
      return "Must contain at least one non-numeric character";
    }
    return null;
  };

  const handleNameChange = (value: string) => {
    setEditedName(value);
    setIsNameDirty(value !== system?.displayName);
  };

  const handleShortNameChange = (value: string) => {
    setEditedShortName(value);
    setIsShortNameDirty(value !== (system?.shortName || ""));
    setShortNameError(validateShortName(value));
  };

  const hasChanges =
    isNameDirty || isShortNameDirty || isCompositeDirty || isAdminDirty;
  const hasGeneralChanges = isNameDirty || isShortNameDirty;

  const handleSave = async () => {
    if (!hasChanges || !system || shortNameError) return;

    setIsSaving(true);
    try {
      // Save regular settings (displayName, shortName)
      if (isNameDirty || isShortNameDirty) {
        const settings: {
          displayName?: string;
          shortName?: string | null;
        } = {};

        if (isNameDirty) settings.displayName = editedName;
        if (isShortNameDirty) settings.shortName = editedShortName || null;

        console.log("Settings to save:", settings);

        const response = await fetch(
          `/api/admin/systems/${system.systemId}/settings`,
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

        // Call onUpdate to update parent component's local state
        if (onUpdate && (isNameDirty || isShortNameDirty)) {
          const updates: { displayName?: string; shortName?: string | null } =
            {};
          if (isNameDirty) updates.displayName = editedName;
          if (isShortNameDirty) updates.shortName = editedShortName || null;
          await onUpdate(system.systemId, updates);
        }
      }

      // Save composite configuration separately
      if (isCompositeDirty && compositeSaveRef.current) {
        const compositeMappings = await compositeSaveRef.current();

        console.log("Composite mappings to save:", compositeMappings);

        const response = await fetch(
          `/api/admin/systems/${system.systemId}/composite-config`,
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
          `/api/admin/systems/${system.systemId}/admin-settings`,
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

      // Reset dirty flags
      setIsNameDirty(false);
      setIsShortNameDirty(false);
      setIsCompositeDirty(false);
      setIsAdminDirty(false);

      // Close modal first to show the updated state immediately
      onClose();

      // Refresh the page to show updated data
      router.refresh();
    } catch (error) {
      console.error("Failed to update system settings:", error);
      // Check if it's a uniqueness error
      if (error instanceof Error && error.message.includes("already in use")) {
        setShortNameError(`Short name "${editedShortName}" is already in use`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedName(system?.displayName || "");
    setEditedShortName(system?.shortName || "");
    setIsNameDirty(false);
    setIsShortNameDirty(false);
    setShortNameError(null);
    onClose();
  };

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
      } else if (
        e.key === "Enter" &&
        hasChanges &&
        !isSaving &&
        !shortNameError
      ) {
        e.preventDefault();
        handleSave();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, hasChanges, isSaving, shortNameError, handleCancel, handleSave]);

  if (!isOpen || !system || typeof document === "undefined") return null;

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
              {system.displayName} Settings
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
              {system.vendorType !== "composite" && (
                <button
                  onClick={() => setActiveTab("capabilities")}
                  className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                    activeTab === "capabilities"
                      ? "text-white border-blue-500 bg-gray-700/50"
                      : "text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600"
                  }`}
                >
                  Capabilities
                </button>
              )}
              {system.vendorType === "composite" && (
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
            {/* General Tab Content */}
            <div className={activeTab === "general" ? "" : "hidden"}>
              {/* Name field */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Display Name
                </label>
                <input
                  type="text"
                  value={editedName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  onBlur={(e) => {
                    const withoutTrailingSpaces = e.target.value.replace(
                      /\s+$/,
                      "",
                    );
                    if (withoutTrailingSpaces !== e.target.value) {
                      handleNameChange(withoutTrailingSpaces);
                    }
                  }}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={isSaving}
                />
              </div>

              {/* Short Name field */}
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Short Name (optional)
                </label>
                <p className="text-xs text-gray-400 mb-2">
                  Used as an alias in URLs and series names. Only letters,
                  digits, and underscores and must contain at least one
                  non-numeric character. Must be unique across all systems.
                </p>
                <input
                  type="text"
                  value={editedShortName}
                  onChange={(e) => handleShortNameChange(e.target.value)}
                  placeholder="e.g., racv_kinkora"
                  className={`w-full px-3 py-2 bg-gray-900 border ${
                    shortNameError ? "border-red-500" : "border-gray-700"
                  } rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                  disabled={isSaving}
                />
                {shortNameError && (
                  <p className="text-xs text-red-400 mt-1">{shortNameError}</p>
                )}
              </div>
            </div>

            {/* Capabilities Tab Content - Only for non-composite systems */}
            {system.vendorType !== "composite" && (
              <div className={activeTab === "capabilities" ? "" : "hidden"}>
                <CapabilitiesTab
                  systemId={system.systemId}
                  shouldLoad={isOpen}
                />
              </div>
            )}

            {/* Composite Tab Content */}
            {system.vendorType === "composite" && (
              <div className={activeTab === "composite" ? "" : "hidden"}>
                <CompositeTab
                  systemId={system.systemId}
                  shouldLoad={isOpen}
                  onDirtyChange={setIsCompositeDirty}
                  onSaveFunctionReady={(fn) => {
                    compositeSaveRef.current = fn;
                  }}
                />
              </div>
            )}

            {/* Admin Tab Content */}
            {isAdmin && (
              <div className={activeTab === "admin" ? "" : "hidden"}>
                <AdminTab
                  systemId={system.systemId}
                  shouldLoad={isOpen}
                  onDirtyChange={setIsAdminDirty}
                  onSaveFunctionReady={(fn) => {
                    adminSaveRef.current = fn;
                  }}
                />
              </div>
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
              disabled={!hasChanges || isSaving || !!shortNameError}
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
