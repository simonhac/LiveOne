"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface PointInfo {
  pointDbId: number;
  systemId: number;
  originId: string;
  originSubId: string | null;
  subsystem: string | null;
  type: string | null;
  subtype: string | null;
  extension: string | null;
  defaultName: string;
  displayName: string | null;
  shortName: string | null;
  active: boolean;
  transform: string | null;
  metricType: string;
  metricUnit: string | null;
  derived: boolean;
  vendorSiteId?: string;
  systemShortName?: string;
  ownerUsername: string;
  vendorType?: string;
}

interface PointInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  pointInfo: PointInfo | null;
  onUpdate: (
    pointDbId: number,
    updates: {
      type?: string | null;
      subtype?: string | null;
      extension?: string | null;
      displayName?: string | null;
      shortName?: string | null;
      active: boolean;
      transform?: string | null;
    },
  ) => Promise<void>;
}

export default function PointInfoModal({
  isOpen,
  onClose,
  pointInfo,
  onUpdate,
}: PointInfoModalProps) {
  const [editedType, setEditedType] = useState(pointInfo?.type || "");
  const [editedSubtype, setEditedSubtype] = useState(pointInfo?.subtype || "");
  const [editedExtension, setEditedExtension] = useState(
    pointInfo?.extension || "",
  );
  const [editedDisplayName, setEditedDisplayName] = useState(
    pointInfo?.displayName || "",
  );
  const [editedShortName, setEditedShortName] = useState(
    pointInfo?.shortName || "",
  );
  const [editedActive, setEditedActive] = useState(!!pointInfo?.active);
  const [editedTransform, setEditedTransform] = useState(
    pointInfo?.transform || "n",
  );
  const [isTypeDirty, setIsTypeDirty] = useState(false);
  const [isSubtypeDirty, setIsSubtypeDirty] = useState(false);
  const [isExtensionDirty, setIsExtensionDirty] = useState(false);
  const [isDisplayNameDirty, setIsDisplayNameDirty] = useState(false);
  const [isShortNameDirty, setIsShortNameDirty] = useState(false);
  const [isActiveDirty, setIsActiveDirty] = useState(false);
  const [isTransformDirty, setIsTransformDirty] = useState(false);
  const [shortNameError, setShortNameError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setEditedType(pointInfo?.type || "");
    setEditedSubtype(pointInfo?.subtype || "");
    setEditedExtension(pointInfo?.extension || "");
    setEditedDisplayName(pointInfo?.displayName || "");
    setEditedShortName(pointInfo?.shortName || "");
    setEditedActive(!!pointInfo?.active);
    setEditedTransform(pointInfo?.transform || "n");
    setIsTypeDirty(false);
    setIsSubtypeDirty(false);
    setIsExtensionDirty(false);
    setIsDisplayNameDirty(false);
    setIsShortNameDirty(false);
    setIsActiveDirty(false);
    setIsTransformDirty(false);
    setShortNameError(null);
  }, [pointInfo, isOpen]);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  const validateShortName = (value: string): string | null => {
    if (!value) return null; // Empty is valid (optional field)
    if (!/^[a-zA-Z0-9_]+$/.test(value)) {
      return "Only letters, digits, and underscores are allowed";
    }
    return null;
  };

  const handleTypeChange = (value: string) => {
    setEditedType(value);
    setIsTypeDirty(value !== (pointInfo?.type || ""));
  };

  const handleSubtypeChange = (value: string) => {
    setEditedSubtype(value);
    setIsSubtypeDirty(value !== (pointInfo?.subtype || ""));
  };

  const handleExtensionChange = (value: string) => {
    setEditedExtension(value);
    setIsExtensionDirty(value !== (pointInfo?.extension || ""));
  };

  const handleDisplayNameChange = (value: string) => {
    setEditedDisplayName(value);
    setIsDisplayNameDirty(value !== (pointInfo?.displayName || ""));
  };

  const handleShortNameChange = (value: string) => {
    setEditedShortName(value);
    setIsShortNameDirty(value !== (pointInfo?.shortName || ""));
    setShortNameError(validateShortName(value));
  };

  const handleActiveChange = (value: boolean) => {
    setEditedActive(value);
    setIsActiveDirty(value !== !!pointInfo?.active);
  };

  const handleTransformChange = (value: string) => {
    setEditedTransform(value);
    setIsTransformDirty(value !== (pointInfo?.transform || "n"));
  };

  const hasChanges =
    isTypeDirty ||
    isSubtypeDirty ||
    isExtensionDirty ||
    isDisplayNameDirty ||
    isShortNameDirty ||
    isActiveDirty ||
    isTransformDirty;

  const handleSave = async () => {
    if (!pointInfo || shortNameError) return;

    setIsSaving(true);
    try {
      const updates: any = { active: editedActive };
      if (isTypeDirty) updates.type = editedType || null;
      if (isSubtypeDirty) updates.subtype = editedSubtype || null;
      if (isExtensionDirty) updates.extension = editedExtension || null;
      if (isDisplayNameDirty) updates.displayName = editedDisplayName || null;
      if (isShortNameDirty) updates.shortName = editedShortName || null;
      if (isTransformDirty)
        updates.transform = editedTransform === "n" ? null : editedTransform;

      await onUpdate(pointInfo.pointDbId, updates);

      // Reset dirty flags
      setIsTypeDirty(false);
      setIsSubtypeDirty(false);
      setIsExtensionDirty(false);
      setIsDisplayNameDirty(false);
      setIsShortNameDirty(false);
      setIsActiveDirty(false);
      setIsTransformDirty(false);

      // Close modal on successful save
      onClose();
    } catch (error) {
      console.error("Failed to update point info:", error);
      // Check if it's a uniqueness error
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        setShortNameError(
          `Short name "${editedShortName}" is already in use for this system`,
        );
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen || !pointInfo || typeof document === "undefined") return null;

  // Handle Enter key to save
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && hasChanges && !isSaving && !shortNameError) {
      e.preventDefault();
      handleSave();
    }
  };

  return createPortal(
    <>
      {/* Backdrop with blur */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]" />

      {/* Dialog */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[10001] w-full max-w-3xl">
        <div
          className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl"
          onKeyDown={handleKeyDown}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4">
            <h2 className="text-lg font-medium text-gray-100">
              Point Information
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
            {/* Original Metadata - Non-editable fields */}
            <div className="border border-gray-600 rounded-md p-3 bg-gray-800/30">
              <div className="text-xs font-medium text-gray-400 mb-2">
                Original Metadata
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  System:
                </label>
                <div className="px-2 font-mono text-sm flex-1 whitespace-nowrap">
                  <span className="text-gray-300">
                    {pointInfo.vendorType || "N/A"}/
                    {pointInfo.vendorSiteId || "N/A"}
                  </span>
                  <span className="text-gray-400">
                    {" "}
                    ({pointInfo.ownerUsername}/
                    {pointInfo.systemShortName || pointInfo.systemId})
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Point:
                </label>
                <div className="px-2 font-mono text-sm flex-1">
                  <span className="text-gray-300 whitespace-nowrap">
                    {pointInfo.originId}
                  </span>
                  <span className="text-gray-400 whitespace-nowrap">
                    {" "}
                    ({pointInfo.defaultName})
                  </span>
                  <span className="text-gray-500 whitespace-nowrap">
                    {" "}
                    ID: {pointInfo.systemId}.{pointInfo.pointDbId}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Sub-Point:
                </label>
                <div className="px-2 text-gray-400 font-mono text-sm flex-1 flex items-center gap-2">
                  <span>{pointInfo.originSubId || "N/A"}</span>
                  {pointInfo.derived && (
                    <span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 text-xs rounded-md border border-purple-500/30">
                      DERIVED
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Subsystem:
                </label>
                <div className="px-2 text-gray-400 text-sm flex-1">
                  {pointInfo.subsystem || "N/A"}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Type and unit:
                </label>
                <div className="px-2 text-gray-400 text-sm flex-1">
                  {pointInfo.metricType}
                  {pointInfo.metricUnit && ` (${pointInfo.metricUnit})`}
                </div>
              </div>
            </div>

            {/* Configuration - Editable fields */}
            <div className="border border-gray-600 rounded-md p-3 bg-gray-800/30 space-y-3">
              <div className="text-xs font-medium text-gray-400 mb-1">
                Configuration
              </div>

              {/* Editable: Active */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Active:
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editedActive}
                    onChange={(e) => handleActiveChange(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-900 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
                    disabled={isSaving}
                  />
                  <span className="text-sm text-gray-400">
                    {editedActive ? "Enabled" : "Disabled"}
                  </span>
                </div>
              </div>

              {/* Editable: Transform */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Transform:
                </label>
                <select
                  value={editedTransform}
                  onChange={(e) => handleTransformChange(e.target.value)}
                  className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={isSaving}
                >
                  <option value="n">none (unchanged)</option>
                  <option value="i">invert (multiply by -1)</option>
                  <option value="d">differentiate (delta from previous)</option>
                </select>
              </div>

              {/* Editable: Display Name */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Display Name:
                </label>
                <input
                  type="text"
                  value={editedDisplayName}
                  onChange={(e) => handleDisplayNameChange(e.target.value)}
                  placeholder={pointInfo.defaultName}
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={isSaving}
                />
              </div>

              {/* Editable: Alias (Short Name) */}
              <div>
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                    Alias:
                  </label>
                  <div className="flex-1">
                    <input
                      type="text"
                      value={editedShortName}
                      onChange={(e) => handleShortNameChange(e.target.value)}
                      placeholder="e.g., batt_main, solar_east"
                      className={`w-full px-3 py-2 bg-gray-900 border ${
                        shortNameError ? "border-red-500" : "border-gray-700"
                      } rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono`}
                      disabled={isSaving}
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-400 mt-1 ml-[8.5rem]">
                  Optional. Only letters, digits, and underscores. Must be
                  unique within this system.
                </p>
                {shortNameError && (
                  <p className="text-xs text-red-400 mt-1 ml-[8.5rem]">
                    {shortNameError}
                  </p>
                )}
              </div>
            </div>

            {/* Taxonomy - Classification fields */}
            <div className="border border-gray-600 rounded-md p-3 bg-gray-800/30 space-y-3">
              <div className="text-xs font-medium text-gray-400 mb-1">
                Taxonomy
              </div>

              {/* Editable: Type (dropdown) */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Type:
                </label>
                <select
                  value={editedType}
                  onChange={(e) => handleTypeChange(e.target.value)}
                  className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={isSaving}
                >
                  <option value="">-- Select Type --</option>
                  <option value="source">source</option>
                  <option value="load">load</option>
                  <option value="bidi">bidi</option>
                </select>
              </div>

              {/* Editable: Subtype (free text) */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Subtype:
                </label>
                <input
                  type="text"
                  value={editedSubtype}
                  onChange={(e) => handleSubtypeChange(e.target.value)}
                  placeholder="e.g., pool, ev, solar1"
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={isSaving}
                />
              </div>

              {/* Editable: Extension (free text) */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Extension:
                </label>
                <input
                  type="text"
                  value={editedExtension}
                  onChange={(e) => handleExtensionChange(e.target.value)}
                  placeholder="e.g. local, remote, hws, ev, hvac"
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={isSaving}
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 rounded-md transition-colors min-w-24"
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || isSaving || !!shortNameError}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-w-24"
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
