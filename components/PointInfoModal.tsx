"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface PointInfo {
  pointDbId: number;
  pointId: string;
  pointSubId: string | null;
  subsystem: string | null;
  type: string | null;
  subtype: string | null;
  extension: string | null;
  defaultName: string;
  name: string | null;
  shortName: string | null;
  metricType: string;
  metricUnit: string | null;
  vendorSiteId?: string;
  systemShortName?: string;
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
      name?: string | null;
      shortName?: string | null;
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
  const [editedName, setEditedName] = useState(pointInfo?.name || "");
  const [editedShortName, setEditedShortName] = useState(
    pointInfo?.shortName || "",
  );
  const [isTypeDirty, setIsTypeDirty] = useState(false);
  const [isSubtypeDirty, setIsSubtypeDirty] = useState(false);
  const [isExtensionDirty, setIsExtensionDirty] = useState(false);
  const [isNameDirty, setIsNameDirty] = useState(false);
  const [isShortNameDirty, setIsShortNameDirty] = useState(false);
  const [shortNameError, setShortNameError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setEditedType(pointInfo?.type || "");
    setEditedSubtype(pointInfo?.subtype || "");
    setEditedExtension(pointInfo?.extension || "");
    setEditedName(pointInfo?.name || "");
    setEditedShortName(pointInfo?.shortName || "");
    setIsTypeDirty(false);
    setIsSubtypeDirty(false);
    setIsExtensionDirty(false);
    setIsNameDirty(false);
    setIsShortNameDirty(false);
    setShortNameError(null);
  }, [pointInfo, isOpen]);

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

  const handleNameChange = (value: string) => {
    setEditedName(value);
    setIsNameDirty(value !== (pointInfo?.name || ""));
  };

  const handleShortNameChange = (value: string) => {
    setEditedShortName(value);
    setIsShortNameDirty(value !== (pointInfo?.shortName || ""));
    setShortNameError(validateShortName(value));
  };

  const hasChanges =
    isTypeDirty ||
    isSubtypeDirty ||
    isExtensionDirty ||
    isNameDirty ||
    isShortNameDirty;

  const handleSave = async () => {
    if (!hasChanges || !pointInfo || shortNameError) return;

    setIsSaving(true);
    try {
      const updates: any = {};
      if (isTypeDirty) updates.type = editedType || null;
      if (isSubtypeDirty) updates.subtype = editedSubtype || null;
      if (isExtensionDirty) updates.extension = editedExtension || null;
      if (isNameDirty) updates.name = editedName || null;
      if (isShortNameDirty) updates.shortName = editedShortName || null;

      await onUpdate(pointInfo.pointDbId, updates);

      // Reset dirty flags
      setIsTypeDirty(false);
      setIsSubtypeDirty(false);
      setIsExtensionDirty(false);
      setIsNameDirty(false);
      setIsShortNameDirty(false);

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

  // Compute series ID: liveone.mondo.{system shortname}.{type}.{subtype}.{extension}.{metric type}
  const getSeriesId = () => {
    if (!pointInfo) return { prefix: "", parts: [] };

    const prefix = pointInfo.systemShortName
      ? `liveone.mondo.${pointInfo.systemShortName}.`
      : "liveone.mondo.";

    const parts = [];
    if (editedType) parts.push(editedType);
    if (editedSubtype) parts.push(editedSubtype);
    if (editedExtension) parts.push(editedExtension);
    if (pointInfo.metricType) parts.push(pointInfo.metricType);

    return { prefix, parts };
  };

  if (!isOpen || !pointInfo || typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* Backdrop with blur */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[10001] w-full max-w-xl">
        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
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
            <div className="border border-gray-600 rounded-md p-3 bg-gray-800/30 space-y-1">
              <div className="text-xs font-medium text-gray-400 mb-1">
                Original Metadata
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Vendor Site ID:
                </label>
                <div className="px-2 py-1 text-gray-400 font-mono text-sm flex-1">
                  {pointInfo.vendorSiteId || "N/A"}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Point ID:
                </label>
                <div className="px-2 py-1 text-gray-400 font-mono text-sm flex-1">
                  {pointInfo.pointId}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Name:
                </label>
                <div className="px-2 py-1 text-gray-400 text-sm flex-1">
                  {pointInfo.defaultName}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Point Sub ID:
                </label>
                <div className="px-2 py-1 text-gray-400 font-mono text-sm flex-1">
                  {pointInfo.pointSubId || "N/A"}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Subsystem:
                </label>
                <div className="px-2 py-1 text-gray-400 text-sm flex-1">
                  {pointInfo.subsystem || "N/A"}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Metric Type:
                </label>
                <div className="px-2 py-1 text-gray-400 text-sm flex-1">
                  {pointInfo.metricType}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Metric Unit:
                </label>
                <div className="px-2 py-1 text-gray-400 text-sm flex-1">
                  {pointInfo.metricUnit || "N/A"}
                </div>
              </div>
            </div>

            {/* Configuration - Editable fields */}
            <div className="border border-gray-600 rounded-md p-3 bg-gray-800/30 space-y-3">
              <div className="text-xs font-medium text-gray-400 mb-1">
                Configuration
              </div>

              {/* Editable: Custom Name */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Custom Name:
                </label>
                <input
                  type="text"
                  value={editedName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder={pointInfo.defaultName}
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={isSaving}
                />
              </div>

              {/* Editable: Short Name */}
              <div>
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                    Short Name:
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
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
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
                  placeholder="e.g., additional qualifier"
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                  disabled={isSaving}
                />
              </div>

              {/* Series ID Display */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                  Series ID:
                </label>
                {editedType && editedSubtype ? (
                  <div className="px-2 py-1 text-gray-400 font-mono text-sm flex-1 break-all">
                    <span className="text-gray-600">
                      {getSeriesId().prefix}
                    </span>
                    <span className="text-gray-400">
                      {getSeriesId().parts.join(".")}
                    </span>
                  </div>
                ) : (
                  <div className="px-2 py-1 text-gray-500 text-sm flex-1 italic">
                    (type and subtype must be set for a series ID)
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-700 flex gap-3">
            <button
              onClick={onClose}
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
