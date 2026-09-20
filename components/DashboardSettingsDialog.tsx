"use client";

import { useMemo, useState } from "react";
import { reliedUponMessage } from "@/lib/integrity/message";
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
import ShareLinksPanel, {
  type ShareApi,
  type ShareTokenRow,
} from "@/components/ShareLinksPanel";
import GrantsPanel from "@/components/GrantsPanel";
import { recomputeAreaFlow } from "@/lib/areas/recompute-flow";
import { isDeviceQuery } from "@/lib/queries/keys";

/**
 * Rename / set shortname / set-or-unset default / delete a composition dashboard. Extracted from
 * DashboardClient so the header dashboard switcher can open the same dialog. The default
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
  id: string;
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
  const [activeTab, setActiveTab] = useState<"general" | "share" | "people">(
    "general",
  );

  const isDefault = prefs?.preferences.defaultDashboardId === id;
  const aliasValid = isValidAlias(alias.trim());

  // Read-only public share links for THIS dashboard (keyed by dashboard id). A holder opens
  // `/dashboard/{id}?access=<token>` with no sign-in, scoped to exactly what the dashboard shows.
  // Deliberately the id form, not the pretty slug one: slugs are renameable, and the id is what
  // keeps an already-sent link durable (the token resolves the dashboard regardless).
  const shareUrl = (token: string) =>
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/dashboard/${id}?access=${token}`;
  //
  // ⚠️ Three deliberate wire differences from the legacy `/share` twin, none of which `tsc` can see:
  //  - the response CONTAINER key is still `tokens` (§9.2 renames the route, not the payload) — a
  //    rename there would have been an invisible `?? []` that renders "no links" forever;
  //  - `expiresInDays` must be a NUMBER. The legacy route silently coerced `"7"` to "never expires";
  //    the v4 route 422s. `ShareLinksPanel` already holds `number | null`, so this is proof, not a fix;
  //  - PATCH/DELETE of an unknown token answer 404/409 instead of `200 {ok:false}` — the legacy pair
  //    reported "nothing happened" as success, which on a revoke is the difference between "revoked"
  //    and "still live". `res.ok` therefore now means it really happened.
  const shareApi = useMemo<ShareApi>(
    () => ({
      list: async () => {
        const res = await fetch(`/api/v4/dashboards/${id}/shares`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ((await res.json()).tokens ?? []) as ShareTokenRow[];
      },
      create: async (label, expiresInDays) => {
        const res = await fetch(`/api/v4/dashboards/${id}/shares`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `null` = never expires; anything else must already be a number (422 otherwise).
          body: JSON.stringify({ label, expiresInDays }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { token: string };
      },
      revoke: async (token) => {
        const res = await fetch(
          `/api/v4/dashboards/${id}/shares?token=${encodeURIComponent(token)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
      rename: async (token, label) => {
        const res = await fetch(`/api/v4/dashboards/${id}/shares`, {
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
      // v4 meta vocabulary: `name`/`slug`, not `displayName`/`alias`. An empty `slug` clears it.
      const res = await fetch(`/api/v4/dashboards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: normalizeAlias(alias),
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
      const res = await fetch(`/api/v4/dashboards/${id}`, { method: "DELETE" });
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: MY_DASHBOARDS_KEY });
        await queryClient.invalidateQueries({ queryKey: USER_PREFERENCES_KEY });
        toast.success("Dashboard deleted");
        onClose();
        onDeleted();
      } else {
        const body = await res.json().catch(() => ({}));
        // A 409 from the referential-integrity gate carries the LIST — grantees, live links, users
        // whose landing page this is. Showing only `body.error` here would render the anonymous
        // count that gate exists to replace.
        setError(reliedUponMessage(body) ?? body?.error ?? "Could not delete");
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
      // Blow away the cached chart/sankey data for the recomputed devices so the corrected Sankey shows
      // immediately — siteData/flowMatrix are settled, long-`staleTime` queries that would otherwise
      // serve the pre-recompute matrix until a hard refresh.
      for (const systemId of systemIds) {
        await queryClient.invalidateQueries({
          predicate: (q) => isDeviceQuery(systemId, q.queryKey),
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
        className="fixed inset-0 z-[10000] bg-scrim backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[10001] flex items-center justify-center px-4">
        <div className="pointer-events-auto w-full max-w-[560px] rounded-lg border border-line bg-surface-overlay shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-6 py-4">
            <h2 className="text-lg font-semibold text-ink">
              Dashboard settings
            </h2>
            <button
              onClick={onClose}
              className="rounded p-1 transition-colors hover:bg-surface-control"
            >
              <X className="h-5 w-5 text-ink-muted" />
            </button>
          </div>
          {/* Tabs */}
          <div className="border-b border-line px-6">
            <div className="-mb-px flex items-end">
              <button
                onClick={() => setActiveTab("general")}
                className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === "general"
                    ? "border-focus bg-selected text-ink"
                    : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink-secondary"
                }`}
              >
                General
              </button>
              <button
                onClick={() => setActiveTab("share")}
                className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === "share"
                    ? "border-focus bg-selected text-ink"
                    : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink-secondary"
                }`}
              >
                Share
              </button>
              <button
                onClick={() => setActiveTab("people")}
                className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === "people"
                    ? "border-focus bg-selected text-ink"
                    : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink-secondary"
                }`}
              >
                People
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
          ) : activeTab === "people" ? (
            <div className="px-6 py-4">
              <GrantsPanel dashboardId={id} enabled={activeTab === "people"} />
            </div>
          ) : (
            <div className="space-y-4 px-6 py-4">
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                  Name
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-ink-strong"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                  Shortname (optional)
                </span>
                <input
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  onBlur={() => setAlias(normalizeAlias(alias))}
                  placeholder="e.g. home-farm"
                  className="w-full rounded-md border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-ink-strong placeholder:text-ink-disabled"
                />
                {!aliasValid && (
                  <span className="mt-1 block text-xs text-warn">
                    Lowercase letters, numbers and hyphens only
                  </span>
                )}
              </label>
              <button
                onClick={toggleDefault}
                disabled={busy}
                className="inline-flex items-center gap-1.5 text-sm text-accent-ink transition-colors hover:text-accent-ink-hover disabled:opacity-60"
              >
                <Star
                  className={`h-4 w-4 ${isDefault ? "fill-star text-star" : ""}`}
                />
                {isDefault
                  ? "Remove as default dashboard"
                  : "Set as my default dashboard"}
              </button>
              {areaIds && areaIds.length > 0 && (
                <div className="border-t border-line-soft pt-4">
                  <button
                    onClick={recompute}
                    disabled={recomputing || busy}
                    className="inline-flex items-center gap-1.5 text-sm text-ink-secondary transition-colors hover:text-ink disabled:opacity-60"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${recomputing ? "animate-spin" : ""}`}
                    />
                    {recomputing ? "Recomputing sankeys…" : "Recompute sankeys"}
                  </button>
                  <p className="mt-1 text-xs text-ink-faint">
                    Rebuilds the energy-flow (Sankey) history for this dashboard
                    — e.g. after a point sign or role change.
                  </p>
                </div>
              )}
              {error && (
                <p className="whitespace-pre-line text-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          )}
          {activeTab === "general" ? (
            <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
              {confirmingDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink-muted">
                    Delete permanently?
                  </span>
                  <button
                    onClick={remove}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md bg-danger-solid px-3 py-2 text-sm text-ink transition-colors hover:bg-danger-solid-hover disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    {busy ? "Deleting…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                    className="rounded-md px-2 py-2 text-sm text-ink-muted hover:text-ink disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-danger transition-colors hover:bg-danger-panel disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              )}
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  disabled={busy}
                  className="rounded-md border border-line-strong px-4 py-2 text-ink-secondary transition-colors hover:text-ink disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={busy || !name.trim() || !aliasValid}
                  className="min-w-[90px] rounded-md bg-accent px-5 py-2 text-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-3 border-t border-line px-6 py-4">
              <button
                onClick={onClose}
                className="rounded-md border border-line-strong px-4 py-2 text-ink-secondary transition-colors hover:text-ink"
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
