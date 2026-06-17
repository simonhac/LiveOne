"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Trash2, X, Star } from "lucide-react";
import { toast } from "sonner";
import {
  userPreferencesQuery,
  USER_PREFERENCES_KEY,
  MY_DASHBOARDS_KEY,
} from "@/lib/queries";
import { normalizeAlias, isValidAlias } from "@/lib/dashboard/alias";
import ShareLinksPanel, {
  type ShareApi,
  type ShareTokenRow,
} from "@/components/ShareLinksPanel";

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
  onDeleted,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  id: number;
  initialName: string;
  initialAlias: string;
  onDeleted: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: prefs } = useQuery(userPreferencesQuery(isOpen));
  const [name, setName] = useState(initialName);
  const [alias, setAlias] = useState(initialAlias);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"general" | "share">("general");

  const isDefault = prefs?.preferences.defaultDashboardId === id;
  const aliasValid = isValidAlias(alias.trim());

  // Read-only public share links for THIS dashboard (keyed by dashboard id). A holder opens
  // `/dashboard/id/{id}?access=<token>` with no sign-in, scoped to exactly what the dashboard shows.
  const shareUrl = (token: string) =>
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/dashboard/id/${id}?access=${token}`;
  const shareApi = useMemo<ShareApi>(
    () => ({
      list: async () => {
        const res = await fetch(`/api/dashboards/${id}/share`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ((await res.json()).tokens ?? []) as ShareTokenRow[];
      },
      create: async (label, expiresInDays) => {
        const res = await fetch(`/api/dashboards/${id}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, expiresInDays }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { token: string };
      },
      revoke: async (token) => {
        const res = await fetch(
          `/api/dashboards/${id}/share?token=${encodeURIComponent(token)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
      rename: async (token, label) => {
        const res = await fetch(`/api/dashboards/${id}/share`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, label }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
    }),
    [id],
  );

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

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[10000] bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[10001] flex items-center justify-center px-4">
        <div className="pointer-events-auto w-full max-w-[560px] rounded-lg border border-gray-700 bg-gray-800 shadow-xl">
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
          {/* Tabs */}
          <div className="border-b border-gray-700 px-6">
            <div className="-mb-px flex items-end">
              <button
                onClick={() => setActiveTab("general")}
                className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === "general"
                    ? "border-blue-500 bg-gray-700/50 text-white"
                    : "border-transparent text-gray-400 hover:border-gray-600 hover:text-gray-300"
                }`}
              >
                General
              </button>
              <button
                onClick={() => setActiveTab("share")}
                className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === "share"
                    ? "border-blue-500 bg-gray-700/50 text-white"
                    : "border-transparent text-gray-400 hover:border-gray-600 hover:text-gray-300"
                }`}
              >
                Share
              </button>
            </div>
          </div>
          {activeTab === "share" ? (
            <div className="px-6 py-4">
              <ShareLinksPanel
                api={shareApi}
                shareUrl={shareUrl}
                enabled={activeTab === "share"}
              />
            </div>
          ) : (
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
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
          )}
          {activeTab === "general" ? (
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
          ) : (
            <div className="flex items-center justify-end gap-3 border-t border-gray-700 px-6 py-4">
              <button
                onClick={onClose}
                className="rounded-md border border-gray-600 px-4 py-2 text-gray-300 transition-colors hover:text-white"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
