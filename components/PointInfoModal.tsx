"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { isValidLogicalPathStem } from "@/lib/identifiers/logical-path";

interface PointInfo {
  pointIndex: number;
  systemId: number;
  subsystem: string | null;
  originName: string;
  displayName: string | null;
  active: boolean;
  transform: string | null;
  metricType: string;
  metricUnit: string | null;
  derived: boolean;
  vendorSiteId?: string;
  systemShortName?: string;
  ownerUsername: string;
  vendorType?: string;
  logicalPath: string | null;
  logicalPathStem: string | null;
  physicalPath: string;
}

interface PointInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  pointInfo: PointInfo | null;
  onUpdate: (
    pointIndex: number,
    updates: {
      displayName?: string | null;
      active: boolean;
      transform?: string | null;
      logicalPathStem?: string | null;
    },
  ) => Promise<void>;
}

export default function PointInfoModal({
  isOpen,
  onClose,
  pointInfo,
  onUpdate,
}: PointInfoModalProps) {
  const [editedDisplayName, setEditedDisplayName] = useState(
    pointInfo?.displayName || "",
  );
  const [editedActive, setEditedActive] = useState(!!pointInfo?.active);
  const [editedTransform, setEditedTransform] = useState(
    pointInfo?.transform || "n",
  );
  const [editedLogicalPathStem, setEditedLogicalPathStem] = useState(
    pointInfo?.logicalPathStem || "",
  );
  const [isDisplayNameDirty, setIsDisplayNameDirty] = useState(false);
  const [isActiveDirty, setIsActiveDirty] = useState(false);
  const [isTransformDirty, setIsTransformDirty] = useState(false);
  const [isLogicalPathStemDirty, setIsLogicalPathStemDirty] = useState(false);
  const [logicalPathStemError, setLogicalPathStemError] = useState<
    string | null
  >(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setEditedDisplayName(pointInfo?.displayName || "");
    setEditedActive(!!pointInfo?.active);
    setEditedTransform(pointInfo?.transform || "n");
    setEditedLogicalPathStem(pointInfo?.logicalPathStem || "");
    setIsDisplayNameDirty(false);
    setIsActiveDirty(false);
    setIsTransformDirty(false);
    setIsLogicalPathStemDirty(false);
    setLogicalPathStemError(null);
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

  const handleDisplayNameChange = (value: string) => {
    setEditedDisplayName(value);
    setIsDisplayNameDirty(value !== (pointInfo?.displayName || ""));
  };

  const handleActiveChange = (value: boolean) => {
    setEditedActive(value);
    setIsActiveDirty(value !== !!pointInfo?.active);
  };

  const handleTransformChange = (value: string) => {
    setEditedTransform(value);
    setIsTransformDirty(value !== (pointInfo?.transform || "n"));
  };

  const handleLogicalPathStemChange = (value: string) => {
    setEditedLogicalPathStem(value);
    setIsLogicalPathStemDirty(value !== (pointInfo?.logicalPathStem || ""));

    // Validate the stem
    if (value === "") {
      setLogicalPathStemError(null); // Empty is allowed (nullable)
    } else if (!isValidLogicalPathStem(value)) {
      setLogicalPathStemError(
        "Use letters, numbers, underscores, hyphens. Separate segments with dots (e.g., source.solar)",
      );
    } else {
      setLogicalPathStemError(null);
    }
  };

  const hasChanges =
    isDisplayNameDirty ||
    isActiveDirty ||
    isTransformDirty ||
    isLogicalPathStemDirty;
  const hasErrors = logicalPathStemError !== null;

  const handleSave = async () => {
    if (!pointInfo || hasErrors) return;

    setIsSaving(true);
    try {
      const updates: any = { active: editedActive };
      if (isDisplayNameDirty) updates.displayName = editedDisplayName || null;
      if (isTransformDirty)
        updates.transform = editedTransform === "n" ? null : editedTransform;
      if (isLogicalPathStemDirty)
        updates.logicalPathStem = editedLogicalPathStem || null;

      await onUpdate(pointInfo.pointIndex, updates);

      // Reset dirty flags
      setIsDisplayNameDirty(false);
      setIsActiveDirty(false);
      setIsTransformDirty(false);
      setIsLogicalPathStemDirty(false);

      // Close modal on successful save
      onClose();
    } catch (error) {
      console.error("Failed to update point info:", error);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen || !pointInfo || typeof document === "undefined") return null;

  // Handle Enter key to save
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && hasChanges && !hasErrors && !isSaving) {
      e.preventDefault();
      handleSave();
    }
  };

  // Compute the full logical path from edited stem
  const computedLogicalPath = editedLogicalPathStem
    ? `${editedLogicalPathStem}/${pointInfo.metricType}`
    : null;

  return createPortal(
    <>
      {/* Backdrop with blur */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]" />

      {/* Dialog */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[10001] w-fit">
        <div
          className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl"
          onKeyDown={handleKeyDown}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4">
            <h2 className="text-lg font-medium text-gray-100">
              Point Information{" "}
              <span className="text-gray-500">
                ID: {pointInfo.systemId}.{pointInfo.pointIndex}
              </span>
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
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="w-28 text-gray-400">Vendor/ID:</span>
                <span className="text-gray-300 font-mono">
                  {pointInfo.vendorType}/{pointInfo.vendorSiteId}
                </span>
                <span className="text-gray-400 ml-2">
                  ID: {pointInfo.systemId}
                  {pointInfo.systemShortName &&
                    ` (${pointInfo.systemShortName})`}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-28 text-gray-400">Physical Path:</span>
                <span className="text-gray-300 font-mono">
                  {pointInfo.physicalPath}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-28 text-gray-400">Original Name:</span>
                <span className="text-gray-300">{pointInfo.originName}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-28 text-gray-400">Type and unit:</span>
                <span className="text-gray-300">
                  {pointInfo.metricType}
                  {pointInfo.metricUnit && (
                    <span className="text-gray-400">
                      {" "}
                      ({pointInfo.metricUnit})
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-28 text-gray-400">Subsystem:</span>
                <span className="text-gray-300">
                  {pointInfo.subsystem || "-"}
                </span>
              </div>
            </div>

            {/* Editable Fields */}
            <div className="space-y-3 pt-2">
              {/* Display Name */}
              <div className="flex items-center gap-3">
                <label className="w-28 text-sm text-gray-400">
                  Display Name:
                </label>
                <input
                  type="text"
                  value={editedDisplayName}
                  onChange={(e) => handleDisplayNameChange(e.target.value)}
                  placeholder={pointInfo.originName}
                  className={`w-[435px] px-3 py-1.5 bg-gray-700 border ${isDisplayNameDirty ? "border-blue-500" : "border-gray-600"} rounded text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50`}
                />
              </div>

              {/* Logical Path Stem */}
              <div className="flex items-start gap-3">
                <label className="w-28 text-sm text-gray-400 pt-1.5">
                  Logical Path:
                </label>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editedLogicalPathStem}
                      onChange={(e) =>
                        handleLogicalPathStemChange(e.target.value)
                      }
                      placeholder="e.g., source.solar"
                      className={`w-[300px] px-3 py-1.5 bg-gray-700 border ${
                        logicalPathStemError
                          ? "border-red-500"
                          : isLogicalPathStemDirty
                            ? "border-blue-500"
                            : "border-gray-600"
                      } rounded text-gray-200 text-sm font-mono focus:outline-none focus:ring-2 ${
                        logicalPathStemError
                          ? "focus:ring-red-500/50"
                          : "focus:ring-blue-500/50"
                      }`}
                    />
                    <span className="text-gray-500 text-sm">/</span>
                    <span className="text-gray-400 text-sm font-mono">
                      {pointInfo.metricType}
                    </span>
                  </div>
                  {logicalPathStemError && (
                    <p className="text-red-400 text-xs mt-1">
                      {logicalPathStemError}
                    </p>
                  )}
                </div>
              </div>

              {/* Transform */}
              <div className="flex items-center gap-3">
                <label className="w-28 text-sm text-gray-400">Transform:</label>
                <select
                  value={editedTransform}
                  onChange={(e) => handleTransformChange(e.target.value)}
                  className={`px-3 py-1.5 bg-gray-700 border ${isTransformDirty ? "border-blue-500" : "border-gray-600"} rounded text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50`}
                >
                  <option value="n">None</option>
                  <option value="i">Invert (negate)</option>
                  <option value="d">Differentiate</option>
                </select>
              </div>

              {/* Active */}
              <div className="flex items-center gap-3">
                <label className="w-28 text-sm text-gray-400">Active:</label>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editedActive}
                    onChange={(e) => handleActiveChange(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div
                    className={`w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all ${isActiveDirty ? "ring-2 ring-blue-500/50" : ""} peer-checked:bg-blue-600`}
                  ></div>
                  <span className="ml-3 text-sm text-gray-300">
                    {editedActive ? "Enabled" : "Disabled"}
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 px-6 py-4">
            <button
              onClick={onClose}
              className="w-[125px] px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || hasErrors || isSaving}
              className={`w-[125px] px-4 py-2 text-sm rounded-lg transition-colors ${
                hasChanges && !hasErrors && !isSaving
                  ? "bg-blue-600 hover:bg-blue-700 text-white"
                  : "bg-gray-600 text-gray-400 cursor-not-allowed"
              }`}
            >
              {isSaving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
