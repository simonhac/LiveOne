"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Layers, MapPin, Trash2, X } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import { fetchJson } from "@/lib/queries";
import { normalizeAlias, isValidAlias } from "@/lib/dashboard/alias";
import {
  nemRegionForLocation,
  nemRegionShortLabel,
} from "@/lib/vendors/openelectricity/region";
import MembersTab from "./MembersTab";
import BindingsTab from "./BindingsTab";
import type {
  AreaEditPayload,
  CandidateSystem,
  CandidateSystemsResponse,
} from "./types";

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

type EditTab = "general" | "location" | "members" | "bindings";

/**
 * The owner-facing **Area builder** — one dialog for both creating a multi-device "site" area and
 * editing an existing one. Create collects a name + member devices (a seed device may be pre-selected
 * via `initialMemberSystemId`) and POSTs `/api/areas`; on success it transitions in-place to edit mode
 * so the owner can add location / more members / role→point bindings. Edit exposes General / Location /
 * Members / Bindings tabs backed by the `/api/areas/[id]*` routes. Mirrors NewDashboardDialog's portal
 * modal conventions (ModalContext, sonner, gray-800/700, z-[10000]/[10001]).
 */
export default function AreaBuilderDialog({
  isOpen,
  onClose,
  areaId = null,
  initialMemberSystemId,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** null = create mode; a uuid = edit that area. */
  areaId?: string | null;
  /** A device to pre-seed (locked) as member #1 in create mode. */
  initialMemberSystemId?: number;
  /** Called after any mutation so the caller can refresh server-rendered lists (router.refresh). */
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const { registerModal, unregisterModal } = useModalContext();

  const [activeAreaId, setActiveAreaId] = useState<string | null>(areaId);
  const isEdit = activeAreaId != null;

  // Create-mode form state.
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [members, setMembers] = useState<number[]>(
    initialMemberSystemId != null ? [initialMemberSystemId] : [],
  );

  // Edit-mode tab + form state (seeded from the detail query).
  const [tab, setTab] = useState<EditTab>("general");
  const [editName, setEditName] = useState("");
  const [editAlias, setEditAlias] = useState("");
  const [locState, setLocState] = useState("");
  const [locPostcode, setLocPostcode] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Reset to the mode requested by props each time the dialog opens.
    setActiveAreaId(areaId);
    setName("");
    setAlias("");
    setMembers(initialMemberSystemId != null ? [initialMemberSystemId] : []);
    setTab("general");
    setError(null);
    setConfirmDelete(false);
    registerModal("area-builder-dialog");
    return () => unregisterModal("area-builder-dialog");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, areaId, initialMemberSystemId]);

  const { data: candidatesResp } = useQuery({
    queryKey: ["area-builder", "candidates"],
    enabled: isOpen,
    queryFn: () =>
      fetchJson<CandidateSystemsResponse>("/api/areas/candidate-systems"),
  });
  const candidates: CandidateSystem[] = candidatesResp?.systems ?? [];

  const { data: detail, refetch: refetchDetail } = useQuery({
    queryKey: ["area-builder", "detail", activeAreaId],
    enabled: isOpen && isEdit,
    queryFn: () => fetchJson<AreaEditPayload>(`/api/areas/${activeAreaId}`),
  });

  // Seed the edit-form fields whenever the detail loads/changes.
  useEffect(() => {
    if (!detail) return;
    setEditName(detail.area.displayName);
    setEditAlias(detail.area.alias ?? "");
    setLocState(detail.area.location?.state ?? "");
    setLocPostcode(detail.area.location?.postcode ?? "");
  }, [detail]);

  const afterMutation = () => {
    onSaved?.();
    queryClient.invalidateQueries({ queryKey: ["areas", "readable"] });
  };

  const aliasValid = isValidAlias(alias.trim());
  const editAliasValid = isValidAlias(editAlias.trim());

  const region = useMemo(
    () =>
      nemRegionForLocation({
        country: "AU",
        state: locState || undefined,
        postcode: locPostcode || undefined,
      }),
    [locState, locPostcode],
  );

  if (!isOpen || typeof document === "undefined") return null;

  // ---- create ----------------------------------------------------------------
  const create = async () => {
    const displayName = name.trim();
    if (!displayName) return setError("Give the site a name");
    if (!aliasValid)
      return setError("Shortname: lowercase letters, numbers, hyphens");
    if (members.length === 0) return setError("Add at least one device");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          alias: normalizeAlias(alias) || undefined,
          memberSystemIds: members,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? "Could not create the site");
        return;
      }
      toast.success(`Created “${displayName}”`);
      afterMutation();
      // Transition to edit mode so the owner can add location / bindings.
      setActiveAreaId(body.id);
      setTab("location");
    } finally {
      setBusy(false);
    }
  };

  // ---- edit: generic PATCH ----------------------------------------------------
  const patchArea = async (
    patch: Record<string, unknown>,
    successMsg: string,
  ) => {
    if (!activeAreaId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/areas/${activeAreaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? "Could not save");
        return;
      }
      toast.success(successMsg);
      afterMutation();
      await refetchDetail();
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!activeAreaId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/areas/${activeAreaId}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? "Could not delete");
        return;
      }
      toast.success("Site archived");
      afterMutation();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // ---- edit: member add/remove ------------------------------------------------
  const memberOp = async (method: "POST" | "DELETE", systemId: number) => {
    if (!activeAreaId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/areas/${activeAreaId}/devices`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? "Could not update members");
        return;
      }
      afterMutation();
      await refetchDetail();
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600";

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[10000] bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[10001] flex items-center justify-center px-4">
        <div className="pointer-events-auto flex max-h-[85vh] w-full max-w-[520px] flex-col rounded-lg border border-gray-700 bg-gray-800 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-700 px-6 py-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <Layers className="h-5 w-5 text-purple-400" />
              {isEdit ? "Edit site" : "New site"}
            </h2>
            <button
              onClick={onClose}
              className="rounded p-1 transition-colors hover:bg-gray-700"
            >
              <X className="h-5 w-5 text-gray-400" />
            </button>
          </div>

          {isEdit && (
            <div className="flex gap-1 border-b border-gray-700 px-4 pt-2">
              {(
                ["general", "location", "members", "bindings"] as EditTab[]
              ).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-t px-3 py-2 text-sm capitalize transition-colors ${
                    tab === t
                      ? "bg-gray-900 text-white"
                      : "text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 space-y-4 overflow-auto px-6 py-4">
            {/* CREATE MODE */}
            {!isEdit && (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                    Name
                  </span>
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Home & Farm"
                    className={inputCls}
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
                    className={inputCls}
                  />
                  {!aliasValid && (
                    <span className="mt-1 block text-xs text-amber-400">
                      Lowercase letters, numbers and hyphens only
                    </span>
                  )}
                </label>
                <MembersTab
                  candidates={candidates}
                  memberIds={members}
                  lockedId={initialMemberSystemId}
                  onAdd={(id) => setMembers((m) => [...new Set([...m, id])])}
                  onRemove={(id) =>
                    setMembers((m) => m.filter((x) => x !== id))
                  }
                />
              </>
            )}

            {/* EDIT: GENERAL */}
            {isEdit && tab === "general" && (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                    Name
                  </span>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                    Shortname
                  </span>
                  <input
                    value={editAlias}
                    onChange={(e) => setEditAlias(e.target.value)}
                    onBlur={() => setEditAlias(normalizeAlias(editAlias))}
                    className={inputCls}
                  />
                </label>
                <div className="flex items-center justify-between border-t border-gray-700 pt-3">
                  {confirmDelete ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-300">
                        Archive this site?
                      </span>
                      <button
                        onClick={del}
                        disabled={busy}
                        className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        Archive
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="text-sm text-gray-400 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300"
                    >
                      <Trash2 className="h-4 w-4" />
                      Archive site
                    </button>
                  )}
                  <button
                    onClick={() =>
                      patchArea(
                        {
                          displayName: editName.trim(),
                          alias: normalizeAlias(editAlias) || null,
                        },
                        "Saved",
                      )
                    }
                    disabled={busy || !editName.trim() || !editAliasValid}
                    className="rounded-md bg-blue-600 px-5 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </>
            )}

            {/* EDIT: LOCATION */}
            {isEdit && tab === "location" && (
              <>
                <p className="text-xs text-gray-500">
                  A site&apos;s location derives its NEM grid region (for the
                  Local Grid card).
                </p>
                <label className="block">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                    State / territory
                  </span>
                  <select
                    value={locState}
                    onChange={(e) => setLocState(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">—</option>
                    {AU_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                    Postcode (optional)
                  </span>
                  <input
                    value={locPostcode}
                    onChange={(e) => setLocPostcode(e.target.value)}
                    placeholder="e.g. 3460"
                    className={inputCls}
                  />
                </label>
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <MapPin className="h-3.5 w-3.5" />
                  {region
                    ? `NEM region: ${nemRegionShortLabel(region)}`
                    : "Off-NEM / no region derived"}
                </div>
                <div className="flex justify-end border-t border-gray-700 pt-3">
                  <button
                    onClick={() =>
                      patchArea(
                        {
                          location: {
                            country: "AU",
                            state: locState || "",
                            postcode: locPostcode.trim() || "",
                          },
                        },
                        "Saved location",
                      )
                    }
                    disabled={busy}
                    className="rounded-md bg-blue-600 px-5 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Save location
                  </button>
                </div>
              </>
            )}

            {/* EDIT: MEMBERS */}
            {isEdit && tab === "members" && detail && (
              <MembersTab
                candidates={candidates}
                memberIds={detail.memberSystemIds}
                busy={busy}
                onAdd={(id) => memberOp("POST", id)}
                onRemove={(id) => memberOp("DELETE", id)}
              />
            )}

            {/* EDIT: BINDINGS */}
            {isEdit && tab === "bindings" && detail && (
              <BindingsTab
                areaId={detail.area.id}
                memberIds={detail.memberSystemIds}
                candidates={candidates}
                initialBindings={detail.bindings}
                onSaved={() => {
                  afterMutation();
                  refetchDetail();
                }}
              />
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>

          {/* CREATE footer */}
          {!isEdit && (
            <div className="flex justify-end gap-3 border-t border-gray-700 px-6 py-4">
              <button
                onClick={onClose}
                disabled={busy}
                className="rounded-md border border-gray-600 px-4 py-2 text-gray-300 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={create}
                disabled={
                  busy || !name.trim() || !aliasValid || members.length === 0
                }
                className="min-w-[100px] rounded-md bg-blue-600 px-6 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create site"}
              </button>
            </div>
          )}
          {isEdit && (
            <div className="flex justify-end border-t border-gray-700 px-6 py-3">
              <button
                onClick={onClose}
                className="rounded-md border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:text-white"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
