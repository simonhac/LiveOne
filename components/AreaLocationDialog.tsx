"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X, MapPin, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useModalContext } from "@/contexts/ModalContext";
import {
  nemRegionForLocation,
  nemRegionShortLabel,
} from "@/lib/vendors/openelectricity/region";

/**
 * Owner-only dialog to set a SITE's physical location (state + optional postcode) — a property of the
 * Area, not the dashboard. DERIVES the NEM region for the "Local Grid (NEM)" card. Talks to GET/PUT
 * `/api/systems/[systemId]/location` (keyed on systemId → its Area while addressing is integer-based).
 * The derived region is previewed live (reusing `nemRegionForLocation` — the single source of truth),
 * and a successful save calls `router.refresh()` so the server re-resolves the grid context.
 *
 * Country is fixed to AU here: the NEM (the only grid this card models) is Australia-only.
 */

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

export default function AreaLocationDialog({
  isOpen,
  onClose,
  systemId,
}: {
  isOpen: boolean;
  onClose: () => void;
  systemId: string;
}) {
  const router = useRouter();
  const { registerModal, unregisterModal } = useModalContext();
  const [state, setState] = useState("");
  const [postcode, setPostcode] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live region preview from the current form — same derivation the server uses.
  const region = nemRegionForLocation({
    country: "AU",
    state: state || undefined,
    postcode: postcode || undefined,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/systems/${systemId}/location`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setState((json.location?.state as string) ?? "");
      setPostcode((json.location?.postcode as string) ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load location");
    } finally {
      setLoading(false);
    }
  }, [systemId]);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  useEffect(() => {
    if (isOpen) {
      registerModal("dashboard-location-dialog");
      return () => unregisterModal("dashboard-location-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/systems/${systemId}/location`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // "" clears the field (see mergeAreaLocation). country is AU for the NEM.
        body: JSON.stringify({
          country: "AU",
          state: state || "",
          postcode: postcode.trim() || "",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Location saved", {
        description: region
          ? `Local Grid region: ${region}`
          : "No NEM grid region for this location.",
      });
      onClose();
      // Re-run the server component so it re-resolves the grid context for the card.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save location");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:py-[8vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] overflow-hidden rounded-lg bg-gray-800 shadow-xl ring-1 ring-gray-700"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Set site location"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-700 px-5 py-3.5">
          <h2 className="flex items-center gap-2.5 text-lg font-semibold text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600/15 text-blue-400 ring-1 ring-inset ring-blue-500/20">
              <MapPin className="h-4 w-4" />
            </span>
            Location
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-700 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm leading-relaxed text-gray-400">
            Your site&apos;s state sets the National Electricity Market (NEM)
            region used by the Local Grid card (price, emissions, renewables).
          </p>

          <div>
            <label
              htmlFor="loc-state"
              className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              State / territory
            </label>
            <select
              id="loc-state"
              value={state}
              disabled={loading}
              onChange={(e) => setState(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              <option value="">Not set</option>
              {AU_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="loc-postcode"
              className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Postcode <span className="text-gray-600">(optional)</span>
            </label>
            <input
              id="loc-postcode"
              type="text"
              inputMode="numeric"
              value={postcode}
              disabled={loading}
              maxLength={4}
              onChange={(e) =>
                setPostcode(e.target.value.replace(/[^\d]/g, ""))
              }
              placeholder="e.g. 3000"
              className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
            <p className="mt-1.5 text-xs text-gray-500">
              Used only if no state is set.
            </p>
          </div>

          {/* Live region preview */}
          <div className="rounded-lg bg-gray-900/70 px-4 py-3 ring-1 ring-gray-700/80">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Grid region
            </span>
            <p className="mt-0.5 text-sm">
              {region ? (
                <span className="font-semibold text-blue-300">
                  {nemRegionShortLabel(region)} ({region})
                </span>
              ) : (
                <span className="text-gray-400">
                  Not on the NEM — no grid card
                </span>
              )}
            </p>
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-700 px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-md px-3.5 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-700 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || loading}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
