"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, CheckCircle2, XCircle } from "lucide-react";
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

  const handleSaveName = async () => {
    if (!isNameDirty || !system) return;

    setIsSaving(true);
    try {
      await onUpdate(system.systemId, { displayName: editedName });
      setIsNameDirty(false);
    } catch (error) {
      console.error("Failed to update system name:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveShortName = async () => {
    if (!isShortNameDirty || !system || shortNameError) return;

    setIsSaving(true);
    try {
      await onUpdate(system.systemId, { shortName: editedShortName || null });
      setIsShortNameDirty(false);
    } catch (error) {
      console.error("Failed to update system short name:", error);
      // Check if it's a uniqueness error
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        setShortNameError(
          `Short name "${editedShortName}" is already in use for ${system.vendorType} systems`,
        );
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelName = () => {
    setEditedName(system?.displayName || "");
    setIsNameDirty(false);
  };

  const handleCancelShortName = () => {
    setEditedShortName(system?.shortName || "");
    setIsShortNameDirty(false);
    setShortNameError(null);
  };

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
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editedName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={isSaving}
                />
                {/* Always reserve space for buttons to prevent layout shift */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleSaveName}
                    disabled={isSaving || !isNameDirty}
                    className={`p-1 rounded-full transition-all ${
                      isNameDirty
                        ? "text-green-500 hover:text-green-400 cursor-pointer"
                        : "text-gray-800 cursor-default"
                    } disabled:opacity-50`}
                    title="Save"
                  >
                    <CheckCircle2 className="w-6 h-6" />
                  </button>
                  <button
                    onClick={handleCancelName}
                    disabled={isSaving || !isNameDirty}
                    className={`p-1 rounded-full transition-all ${
                      isNameDirty
                        ? "text-red-500 hover:text-red-400 cursor-pointer"
                        : "text-gray-800 cursor-default"
                    } disabled:opacity-50`}
                    title="Cancel"
                  >
                    <XCircle className="w-6 h-6" />
                  </button>
                </div>
              </div>
            </div>

            {/* Short Name field */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Short Name (optional)
              </label>
              <p className="text-xs text-gray-400 mb-2">
                Used in history API IDs. Only letters, digits, and underscores.
                Must be unique for {system?.vendorType} systems.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editedShortName}
                  onChange={(e) => handleShortNameChange(e.target.value)}
                  placeholder="e.g., racv_kinkora"
                  className={`flex-1 px-3 py-2 bg-gray-900 border ${
                    shortNameError ? "border-red-500" : "border-gray-700"
                  } rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                  disabled={isSaving}
                />
                {/* Always reserve space for buttons to prevent layout shift */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleSaveShortName}
                    disabled={isSaving || !isShortNameDirty || !!shortNameError}
                    className={`p-1 rounded-full transition-all ${
                      isShortNameDirty && !shortNameError
                        ? "text-green-500 hover:text-green-400 cursor-pointer"
                        : "text-gray-800 cursor-default"
                    } disabled:opacity-50`}
                    title="Save"
                  >
                    <CheckCircle2 className="w-6 h-6" />
                  </button>
                  <button
                    onClick={handleCancelShortName}
                    disabled={isSaving || !isShortNameDirty}
                    className={`p-1 rounded-full transition-all ${
                      isShortNameDirty
                        ? "text-red-500 hover:text-red-400 cursor-pointer"
                        : "text-gray-800 cursor-default"
                    } disabled:opacity-50`}
                    title="Cancel"
                  >
                    <XCircle className="w-6 h-6" />
                  </button>
                </div>
              </div>
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
          <div className="px-6 py-4 border-t border-gray-700">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 rounded-md transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
