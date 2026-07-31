"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { X, Layers } from "lucide-react";
import { toast } from "sonner";
import { useModalContext } from "@/contexts/ModalContext";
import { readableAreasQuery } from "@/lib/queries";
import type { DashboardV4, GroupNode } from "@/lib/dashboard/v4";
import {
  appendGroupToDoc,
  docAreaRefs,
  describeDocWriteError,
} from "@/lib/dashboard/add-area";
import type { ReadableArea } from "@/lib/areas/list";

/** What the server currently holds for this dashboard, as read back after a revision conflict. */
interface DocSnapshot {
  doc: DashboardV4;
  revision: number;
}

/**
 * Add an Area to an EXISTING dashboard — the app's only dashboard-authoring surface.
 *
 * config-v4 Phase 14 stage 14: this writes the **v4 document**, not the v3 `descriptor`. It fetches
 * the Area's capability-derived default GROUP from the server (`GET /api/v4/areas/{ar_…}/default-group`
 * — the same builder the "seed from area" create path persists, so a previewed seed is byte-identical
 * to a saved one), splices it into `doc.root.children`, and `PUT`s the whole document back with
 * `If-Match: "<revision>"` (clean-sheet §9.1). Add-only; remove/reorder is a later follow-up. The
 * picker excludes areas the document already references.
 *
 * 🛑 `If-Match` is not decoration. `updateDashboard`'s descriptor path regenerates `doc` from
 * `descriptor` unconditionally, so the whole-doc `PUT` is the document's ONLY independent author and
 * a lost update here silently discards structure. On a **412** we re-read the current document and
 * re-splice onto THAT — never re-send the stale tree — and a second conflict is reported to the user
 * rather than swallowed.
 */
export default function AddAreaDialog({
  isOpen,
  onClose,
  dashboardId,
  doc,
  revision,
  readableAreas,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  dashboardId: string;
  doc: DashboardV4;
  /** The document revision this page rendered — the `If-Match` precondition. */
  revision: number;
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
    const existing = new Set(docAreaRefs(doc));
    return readableAreas.filter((a) => !existing.has(a.id));
  }, [doc, readableAreas]);

  useEffect(() => {
    if (isOpen) {
      setSelectedAreaId("");
      setError(null);
      registerModal("add-area-dialog");
      return () => unregisterModal("add-area-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  if (!isOpen || typeof document === "undefined") return null;

  /** Re-read the server's current document + revision (after a 412). Null if it can't be read. */
  const readCurrentDoc = async (): Promise<DocSnapshot | null> => {
    const res = await fetch(`/api/v4/dashboards/${dashboardId}`);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as DocSnapshot | null;
    return body?.doc && typeof body.revision === "number" ? body : null;
  };

  type PutOutcome =
    | { kind: "ok" }
    | { kind: "conflict" }
    | { kind: "error"; message: string };

  const putDoc = async (
    next: DashboardV4,
    expectedRevision: number,
  ): Promise<PutOutcome> => {
    const res = await fetch(`/api/v4/dashboards/${dashboardId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${expectedRevision}"`,
      },
      body: JSON.stringify({ doc: next }),
    });
    if (res.ok) return { kind: "ok" };
    if (res.status === 412) return { kind: "conflict" };
    const body = await res.json().catch(() => null);
    return { kind: "error", message: describeDocWriteError(res.status, body) };
  };

  const add = async () => {
    const area = eligible.find((a) => a.id === selectedAreaId);
    if (!area) {
      setError("Pick an area to add");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The Area's capability-derived default group, built server-side (same builder as the seed path).
      const groupRes = await fetch(`/api/v4/areas/${area.id}/default-group`);
      if (!groupRes.ok) {
        const body = await groupRes.json().catch(() => null);
        const code = (body as { error?: string } | null)?.error;
        setError(
          code === "device-mapping-incomplete"
            ? "One of this area's devices isn't registered yet — try again shortly."
            : (code ?? "Could not build the area's default cards"),
        );
        return;
      }
      const { group } = (await groupRes.json()) as { group: GroupNode };

      let outcome = await putDoc(appendGroupToDoc(doc, group), revision);

      // 412 — the document changed since this page rendered (another tab, another device). Re-read
      // it and re-splice onto the CURRENT tree, so the concurrent edit survives; retry exactly once.
      if (outcome.kind === "conflict") {
        const current = await readCurrentDoc();
        if (!current) {
          setError(
            "This dashboard changed in another window and couldn't be re-read. Reload the page and try again.",
          );
          return;
        }
        if (docAreaRefs(current.doc).includes(area.id)) {
          // The other writer added the same area. Nothing to do — don't add it twice.
          toast.success(
            `“${area.displayName}” was already added in another window`,
          );
          onClose();
          onSaved();
          return;
        }
        outcome = await putDoc(
          appendGroupToDoc(current.doc, group),
          current.revision,
        );
        if (outcome.kind === "conflict") {
          setError(
            "This dashboard is being edited in another window. Reload the page and try again.",
          );
          return;
        }
      }
      if (outcome.kind === "error") {
        setError(outcome.message);
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
