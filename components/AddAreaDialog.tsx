"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { X, Layers } from "lucide-react";
import { toast } from "sonner";
import { useModalContext } from "@/contexts/ModalContext";
import { readableAreasQuery } from "@/lib/queries";
import {
  buildDefaultDashboardV3,
  sectionAreaIdsV3,
  type DashboardV3,
} from "@/lib/dashboard/v3";
import type { ReadableArea } from "@/lib/areas/list";

/**
 * Add an Area section to an EXISTING dashboard — the MVP of the deferred v3 configurator. Appends one
 * `AreaSectionV3` (built with the SAME default card set as the "seed from area" create path,
 * `buildDefaultDashboardV3`) to the current descriptor and PATCHes the whole thing back. Add-only;
 * remove/reorder is a later follow-up. The picker excludes areas already on the dashboard.
 */
export default function AddAreaDialog({
  isOpen,
  onClose,
  dashboardId,
  descriptor,
  readableAreas,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  dashboardId: number;
  descriptor: DashboardV3;
  readableAreas: ReadableArea[];
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const { registerModal, unregisterModal } = useModalContext();
  const [selectedAreaId, setSelectedAreaId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only areas not already on the dashboard are addable.
  const eligible = useMemo(() => {
    const existing = new Set(sectionAreaIdsV3(descriptor));
    return readableAreas.filter((a) => !existing.has(a.id));
  }, [descriptor, readableAreas]);

  useEffect(() => {
    if (isOpen) {
      setSelectedAreaId("");
      setError(null);
      registerModal("add-area-dialog");
      return () => unregisterModal("add-area-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  if (!isOpen || typeof document === "undefined") return null;

  const add = async () => {
    const area = eligible.find((a) => a.id === selectedAreaId);
    if (!area) {
      setError("Pick an area to add");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Same default section the "seed from area" create path builds (buildSeedDescriptor).
      const section = buildDefaultDashboardV3({
        areaId: area.id,
        vendorType: area.vendorType,
      }).sections[0];
      const next: DashboardV3 = {
        ...descriptor,
        sections: [...descriptor.sections, section],
      };
      const res = await fetch(`/api/dashboards/${dashboardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ descriptor: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Could not add the area");
        return;
      }
      // The added area is already readable, but keep the areaId→Area resolution map fresh.
      await queryClient.invalidateQueries({
        queryKey: readableAreasQuery().queryKey,
      });
      toast.success(`Added “${area.displayName}”`);
      onClose();
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[10000] bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[10001] flex items-center justify-center px-4">
        <div className="pointer-events-auto w-full max-w-[460px] rounded-lg border border-gray-700 bg-gray-800 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-700 px-6 py-4">
            <h2 className="text-lg font-semibold text-white">Add area</h2>
            <button
              onClick={onClose}
              className="rounded p-1 transition-colors hover:bg-gray-700"
            >
              <X className="h-5 w-5 text-gray-400" />
            </button>
          </div>

          <div className="space-y-4 px-6 py-4">
            <label className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500">
                <Layers className="h-3.5 w-3.5" />
                Area
              </span>
              {eligible.length === 0 ? (
                <p className="text-sm text-gray-400">
                  All your areas are already on this dashboard.
                </p>
              ) : (
                <>
                  <select
                    autoFocus
                    value={selectedAreaId}
                    onChange={(e) => setSelectedAreaId(e.target.value)}
                    className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
                  >
                    <option value="">Select an area…</option>
                    {eligible.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs text-gray-600">
                    Adds the area with its default cards. You can hide or tweak
                    them afterwards.
                  </span>
                </>
              )}
            </label>

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>

          <div className="flex justify-end gap-3 border-t border-gray-700 px-6 py-4">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-gray-600 px-4 py-2 text-gray-300 transition-colors hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={add}
              disabled={busy || !selectedAreaId || eligible.length === 0}
              className="min-w-[100px] rounded-md bg-blue-600 px-6 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
