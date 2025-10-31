"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { JsonView, darkStyles, allExpanded } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

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
  onUpdate: (
    systemId: number,
    updates: { displayName?: string; shortName?: string | null },
  ) => Promise<void>;
}

export default function SystemSettingsDialog({
  isOpen,
  onClose,
  system,
  onUpdate,
}: SystemSettingsDialogProps) {
  const [editedName, setEditedName] = useState(system?.displayName || "");
  const [editedShortName, setEditedShortName] = useState(
    system?.shortName || "",
  );
  const [isNameDirty, setIsNameDirty] = useState(false);
  const [isShortNameDirty, setIsShortNameDirty] = useState(false);
  const [shortNameError, setShortNameError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setEditedName(system?.displayName || "");
    setEditedShortName(system?.shortName || "");
    setIsNameDirty(false);
    setIsShortNameDirty(false);
    setShortNameError(null);
  }, [system, isOpen]);

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

  const hasChanges = isNameDirty || isShortNameDirty;

  const handleSave = async () => {
    if (!hasChanges || !system || shortNameError) return;

    setIsSaving(true);
    try {
      const updates: { displayName?: string; shortName?: string | null } = {};
      if (isNameDirty) updates.displayName = editedName;
      if (isShortNameDirty) updates.shortName = editedShortName || null;

      await onUpdate(system.systemId, updates);

      // Reset dirty flags
      setIsNameDirty(false);
      setIsShortNameDirty(false);

      // Close modal on successful save
      onClose();
    } catch (error) {
      console.error("Failed to update system settings:", error);
      // Check if it's a uniqueness error
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
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
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[10001] w-full max-w-md">
        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <h2 className="text-lg font-medium text-gray-100">
              System Settings
            </h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-700 rounded transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-4 space-y-4">
            {/* Name field */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Display Name
              </label>
              <input
                type="text"
                value={editedName}
                onChange={(e) => handleNameChange(e.target.value)}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={isSaving}
              />
            </div>

            {/* Short Name field */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Short Name (optional)
              </label>
              <p className="text-xs text-gray-400 mb-2">
                Used as an alias in URLs and series names. Only letters, digits,
                and underscores and must contain at least one non-numeric
                character. Must be unique across all systems.
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

            {/* Composite metadata view - only show for composite systems */}
            {system.vendorType === "composite" && system.metadata && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Composite System Configuration
                </label>
                <p className="text-xs text-gray-400 mb-2">
                  This system combines data from multiple source systems.
                </p>
                <div className="bg-gray-950 border border-gray-700 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto font-mono text-xs p-3">
                    <JsonView
                      data={system.metadata}
                      shouldExpandNode={allExpanded}
                      style={darkStyles}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-700 flex gap-3">
            <button
              onClick={handleCancel}
              className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 rounded-md transition-colors"
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || isSaving || !!shortNameError}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
