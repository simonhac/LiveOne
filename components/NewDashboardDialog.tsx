"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { X, Layers } from "lucide-react";
import { toast } from "sonner";
import { useModalContext } from "@/contexts/ModalContext";
import { readableAreasQuery, MY_DASHBOARDS_KEY } from "@/lib/queries";
import { normalizeAlias, isValidAlias } from "@/lib/dashboard/alias";

/**
 * Create a composition-first dashboard (Phase 2b-2): a name + an optional "seed from an Area" choice.
 * Seeding prefills the new dashboard with that Area's default cards (a starting convenience, not a
 * home); leaving it blank starts empty. On success, navigates to the new dashboard.
 */
export default function NewDashboardDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { registerModal, unregisterModal } = useModalContext();
  const [displayName, setDisplayName] = useState("");
  const [alias, setAlias] = useState("");
  const [seedAreaId, setSeedAreaId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: areasResp } = useQuery(readableAreasQuery(isOpen));
  const areas = areasResp?.areas ?? [];
  const aliasValid = isValidAlias(alias.trim());

  useEffect(() => {
    if (isOpen) {
      setDisplayName("");
      setAlias("");
      setSeedAreaId("");
      setError(null);
      registerModal("new-dashboard-dialog");
      return () => unregisterModal("new-dashboard-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  if (!isOpen || typeof document === "undefined") return null;

  const create = async () => {
    const name = displayName.trim();
    if (!name) {
      setError("Give the dashboard a name");
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
      const cleanAlias = normalizeAlias(alias);
      const res = await fetch("/api/dashboards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          alias: cleanAlias || undefined,
          seedAreaId: seedAreaId || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Could not create the dashboard");
        return;
      }
      const { id } = await res.json();
      await queryClient.invalidateQueries({ queryKey: MY_DASHBOARDS_KEY });
      toast.success(`Created “${name}”`);
      onClose();
      router.push(`/dashboard/id/${id}`);
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
            <h2 className="text-lg font-semibold text-white">New dashboard</h2>
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
                autoFocus
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Home &amp; Farm"
                className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600"
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
              {!aliasValid ? (
                <span className="mt-1 block text-xs text-amber-400">
                  Lowercase letters, numbers and hyphens only
                </span>
              ) : (
                <span className="mt-1 block text-xs text-gray-600">
                  Enables a tidy URL like /dashboard/you/home-farm.
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500">
                <Layers className="h-3.5 w-3.5" />
                Start from an area (optional)
              </span>
              <select
                value={seedAreaId}
                onChange={(e) => setSeedAreaId(e.target.value)}
                className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
              >
                <option value="">Empty dashboard</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-gray-600">
                Prefills that area&apos;s default cards. You can add cards from
                any area afterwards.
              </span>
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
              onClick={create}
              disabled={busy || !displayName.trim() || !aliasValid}
              className="min-w-[100px] rounded-md bg-blue-600 px-6 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
