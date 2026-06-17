"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Trash2, X, Star, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  userPreferencesQuery,
  USER_PREFERENCES_KEY,
  MY_DASHBOARDS_KEY,
} from "@/lib/queries";
import { normalizeAlias, isValidAlias } from "@/lib/dashboard/alias";
import { recomputeAreaFlow } from "@/lib/areas/recompute-flow";
import { isSystemQuery } from "@/lib/queries/keys";

/**
 * Rename / set shortname / set-or-unset default / delete a composition dashboard. Extracted from
 * CompositionDashboardClient so the header dashboard switcher can open the same dialog. The default
 * state is read live from the user-preferences query (not a one-way latch), so the star and the
 * Set/Remove toggle always reflect server truth and a failed call can be retried.
 */
export default function DashboardSettingsDialog({
  isOpen,
  onClose,
  id,
  initialName,
  initialAlias,
  areaIds,
  onDeleted,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  id: number;
  initialName: string;
  initialAlias: string;
  /** The dashboard's area ids — enables "Recompute sankeys" (owner/admin only, per the API). */
  areaIds?: string[];
  onDeleted: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: prefs } = useQuery(userPreferencesQuery(isOpen));
  const [name, setName] = useState(initialName);
  const [alias, setAlias] = useState(initialAlias);
  const [busy, setBusy] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDefault = prefs?.preferences.defaultDashboardId === id;
  const aliasValid = isValidAlias(alias.trim());

  if (!isOpen || typeof document === "undefined") return null;

  const toggleDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/user/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultDashboardId: isDefault ? null : id }),
      });
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: USER_PREFERENCES_KEY });
        toast.success(isDefault ? "Default cleared" : "Set as default");
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Could not update default");
      }
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      setError("Name cannot be empty");
      return;
    }
    if (!aliasValid) {
      setError(
        "Shortname may only contain lowercase letters, numbers and hyphens",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name.trim(),
          alias: normalizeAlias(alias),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Could not save");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: MY_DASHBOARDS_KEY });
      toast.success("Saved");
      onClose();
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/dashboards/${id}`, { method: "DELETE" });
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: MY_DASHBOARDS_KEY });
        await queryClient.invalidateQueries({ queryKey: USER_PREFERENCES_KEY });
        toast.success("Dashboard deleted");
        onClose();
        onDeleted();
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Could not delete");
      }
    } finally {
      setBusy(false);
    }
  };

  const recompute = async () => {
    if (!areaIds || areaIds.length === 0 || recomputing) return;
    setRecomputing(true);
    setError(null);
    try {
      let total = 0;
      let failed = 0;
      const systemIds = new Set<number>();
      // Continue on a per-area error so one bad area doesn't abort the rest; report the aggregate.
      for (const areaId of areaIds) {
        try {
          const { recomputed, systemId } = await recomputeAreaFlow(
            areaId,
            (days) =>
              toast.loading(`Recomputing sankeys… ${total + days} days`, {
                id: "recompute-flow",
              }),
          );
          total += recomputed;
          if (systemId != null) systemIds.add(systemId);
        } catch {
          failed += 1;
        }
      }
      // Blow away the cached chart/sankey data for the recomputed systems so the corrected Sankey shows
      // immediately — siteData/flowMatrix are settled, long-`staleTime` queries that would otherwise
      // serve the pre-recompute matrix until a hard refresh.
      for (const systemId of systemIds) {
        await queryClient.invalidateQueries({
          predicate: (q) => isSystemQuery(systemId, q.queryKey),
        });
      }
      const days = `${total} day${total === 1 ? "" : "s"}`;
      if (failed > 0) {
        toast.error(
          `Recomputed ${days}; ${failed} area${failed === 1 ? "" : "s"} failed`,
          { id: "recompute-flow" },
        );
      } else {
        toast.success(`Recomputed ${days}`, { id: "recompute-flow" });
      }
    } finally {
      setRecomputing(false);
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
            <h2 className="text-lg font-semibold text-white">
              Dashboard settings
            </h2>
            <button
              onClick={onClose}
              className="rounded p-1 transition-colors hover:bg-gray-700"
            >
              <X className="h-5 w-5 text-gray-400" />
            </button>
          </div>
          <div className="space-y-4 px-6 py-4">
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                Shortname (optional)
              </span>
              <input
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                onBlur={() => setAlias(normalizeAlias(alias))}
                placeholder="e.g. home-farm"
                className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600"
              />
              {!aliasValid && (
                <span className="mt-1 block text-xs text-amber-400">
                  Lowercase letters, numbers and hyphens only
                </span>
              )}
            </label>
            <button
              onClick={toggleDefault}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-sm text-blue-400 transition-colors hover:text-blue-300 disabled:opacity-60"
            >
              <Star
                className={`h-4 w-4 ${isDefault ? "fill-yellow-400 text-yellow-400" : ""}`}
              />
              {isDefault
                ? "Remove as default dashboard"
                : "Set as my default dashboard"}
            </button>
            {areaIds && areaIds.length > 0 && (
              <div className="border-t border-gray-700/60 pt-4">
                <button
                  onClick={recompute}
                  disabled={recomputing || busy}
                  className="inline-flex items-center gap-1.5 text-sm text-gray-300 transition-colors hover:text-white disabled:opacity-60"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${recomputing ? "animate-spin" : ""}`}
                  />
                  {recomputing ? "Recomputing sankeys…" : "Recompute sankeys"}
                </button>
                <p className="mt-1 text-xs text-gray-500">
                  Rebuilds the energy-flow (Sankey) history for this dashboard —
                  e.g. after a point sign or role change.
                </p>
              </div>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-gray-700 px-6 py-4">
            {confirmingDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400">
                  Delete permanently?
                </span>
                <button
                  onClick={remove}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  {busy ? "Deleting…" : "Confirm"}
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                  className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-950/40 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )}
            <div className="flex gap-3">
              <button
                onClick={onClose}
                disabled={busy}
                className="rounded-md border border-gray-600 px-4 py-2 text-gray-300 transition-colors hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={busy || !name.trim() || !aliasValid}
                className="min-w-[90px] rounded-md bg-blue-600 px-5 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
