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
  CandidateDevice,
  CandidateDevicesResponse,
  MemberChip,
} from "./types";
import type { DeviceId } from "@/lib/ids";

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
 * via `initialMemberSystemId`) and POSTs `/api/v4/areas`; on success it transitions in-place to edit
 * mode so the owner can add location / more members / role→point bindings. Edit exposes General /
 * Location / Members / Bindings tabs backed by the `/api/v4/areas/{ar_…}` routes. Mirrors
 * NewDashboardDialog's portal modal conventions (ModalContext, sonner, gray-800/700, z-[10000]/[10001]).
 *
 * Four things about the v4 surface this dialog had to absorb:
 *  - **members is a `PUT` full replace**, not the `POST`/`DELETE /devices` pair. Add and remove are both
 *    expressed as the whole list. The list sent is always the CURRENT member list with one edit applied
 *    — including the server-managed `helper` members, which the route would not evict by omission
 *    anyway, so the client never leans on that carve-out.
 *  - **the aggregate `GET` folds in members + bindings**; there is no separate v4 `bindings` GET, so the
 *    editor fetches once.
 *  - **the currency is the `dv_` TypeID**, with the integer handle carried alongside for the still
 *    handle-addressed `/api/device/{id}/points`.
 *  - **body-validation failures answer 422, not 400**, and `DELETE` answers `{success:true}` rather than
 *    `{ok:true}` — neither of which this dialog reads (it checks `res.ok` and `body.error`/`body.id`).
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
  /** null = create mode; an `ar_` id = edit that area. */
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

  // Create-mode form state. Members are `dv_` ids — the currency `POST /api/v4/areas` takes — so the
  // seed device (given as an integer handle by the caller) is resolved once the candidate list loads.
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [members, setMembers] = useState<DeviceId[]>([]);

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
    setMembers([]);
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
    queryFn: () => fetchJson<CandidateDevicesResponse>("/api/v4/devices"),
  });
  const candidates: CandidateDevice[] = candidatesResp?.devices ?? [];

  // ONE fetch for the whole aggregate — meta + members + bindings (§9.2). There is no v4 `bindings` GET.
  const { data: detail, refetch: refetchDetail } = useQuery({
    queryKey: ["area-builder", "detail", activeAreaId],
    enabled: isOpen && isEdit,
    queryFn: () => fetchJson<AreaEditPayload>(`/api/v4/areas/${activeAreaId}`),
  });

  // Seed the edit-form fields whenever the detail loads/changes.
  useEffect(() => {
    if (!detail) return;
    setEditName(detail.area.name);
    setEditAlias(detail.area.slug ?? "");
    setLocState(detail.area.location?.state ?? "");
    setLocPostcode(detail.area.location?.postcode ?? "");
  }, [detail]);

  // The seed device arrives as an integer handle; the write surface takes `dv_`. Resolve it once the
  // candidate list is in, and lock it as member #1.
  const lockedDeviceId =
    initialMemberSystemId == null
      ? null
      : (candidates.find((c) => c.legacySystemId === initialMemberSystemId)
          ?.id ?? null);
  useEffect(() => {
    if (!isOpen || isEdit || !lockedDeviceId) return;
    setMembers((m) =>
      m.includes(lockedDeviceId) ? m : [lockedDeviceId, ...m],
    );
  }, [isOpen, isEdit, lockedDeviceId]);

  /** Create-mode member chips, joined from the candidate list (its only possible source there). */
  const createChips: MemberChip[] = members.flatMap((id) => {
    const c = candidates.find((x) => x.id === id);
    return c
      ? [
          {
            id,
            legacySystemId: c.legacySystemId,
            name: c.name,
            vendor: c.vendor,
          },
        ]
      : [];
  });

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
      // v4 vocabulary: `name`/`slug`/`members:[dv_…]`. Answers 201 (not 200) with the SAME
      // `{id, legacySystemId}` body the legacy twin returned, so the transition below is unchanged.
      const res = await fetch("/api/v4/areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: displayName,
          slug: normalizeAlias(alias) || undefined,
          members,
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
      const res = await fetch(`/api/v4/areas/${activeAreaId}`, {
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
      const res = await fetch(`/api/v4/areas/${activeAreaId}`, {
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
  /**
   * State the WHOLE membership (§9.2: `PUT` = declarative full replace). Add and remove are the same
   * call with a different list, computed from the members the aggregate last reported — including the
   * server-managed `helper` ones, so the replace declares the truth rather than relying on the route's
   * "a helper is never evicted by omission" carve-out.
   *
   * Order is significant (array index becomes `area_members.ordinal`), which is why the edit applies to
   * the loaded order rather than rebuilding a set.
   */
  const replaceMembers = async (next: DeviceId[]) => {
    if (!activeAreaId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v4/areas/${activeAreaId}/members`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: next }),
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

  const currentMemberIds = (): DeviceId[] =>
    (detail?.members ?? []).map((m) => m.id);

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
                  members={createChips}
                  lockedId={lockedDeviceId}
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
                          name: editName.trim(),
                          slug: normalizeAlias(editAlias) || null,
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
                members={detail.members}
                busy={busy}
                onAdd={(id) => replaceMembers([...currentMemberIds(), id])}
                onRemove={(id) =>
                  replaceMembers(currentMemberIds().filter((x) => x !== id))
                }
              />
            )}

            {/* EDIT: BINDINGS */}
            {isEdit && tab === "bindings" && detail && (
              <BindingsTab
                areaId={detail.area.id}
                members={detail.members}
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
