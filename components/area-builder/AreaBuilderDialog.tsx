"use client";

import { useEffect, useMemo, useState } from "react";
import { reliedUponMessage } from "@/lib/integrity/message";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Layers, MapPin, Trash2, X } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import { fetchJson, invalidateDevice } from "@/lib/queries";
import { normalizeAlias, isValidAlias } from "@/lib/dashboard/alias";
import {
  nemRegionForLocation,
  nemRegionShortLabel,
} from "@/lib/vendors/openelectricity/region";
import { areaLocationPatchError } from "@/lib/areas/location";
import { TIMEZONE_GROUPS, isValidTimezone } from "@/lib/timezones";
import MembersTab from "./MembersTab";
import BindingsTab from "./BindingsTab";
import { areaDetailKey, cacheSavedAreaDetail } from "./cache";
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
  actingAsAdmin = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** null = create mode; an `ar_` id = edit that area. */
  areaId?: string | null;
  /** A device to pre-seed (locked) as member #1 in create mode. */
  initialMemberSystemId?: number;
  /** Called after any mutation so the caller can refresh server-rendered lists (router.refresh). */
  onSaved?: () => void;
  /** Explicit admin read scope, supplied only by the admin areas page. */
  actingAsAdmin?: boolean;
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
  const [editTimezone, setEditTimezone] = useState("");
  const [editAlias, setEditAlias] = useState("");
  const [locState, setLocState] = useState("");
  const [locPostcode, setLocPostcode] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The named dependents from a refused archive; non-null turns the button into "Archive anyway". */
  const [blockedBy, setBlockedBy] = useState<string | null>(null);

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
    setBlockedBy(null);
    registerModal("area-builder-dialog");
    return () => unregisterModal("area-builder-dialog");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, areaId, initialMemberSystemId]);

  const read = async <T,>(url: string): Promise<T> => {
    if (!actingAsAdmin) return fetchJson<T>(url);
    const res = await fetch(url, { headers: { "x-liveone-admin": "true" } });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Could not load area settings");
    return body as T;
  };

  const { data: candidatesResp } = useQuery({
    queryKey: ["area-builder", "candidates", actingAsAdmin],
    enabled: isOpen,
    queryFn: () => read<CandidateDevicesResponse>("/api/v4/devices"),
  });
  const candidates: CandidateDevice[] = candidatesResp?.devices ?? [];

  // ONE fetch for the whole aggregate — meta + members + bindings (§9.2). There is no v4 `bindings` GET.
  const {
    data: detail,
    refetch: refetchDetail,
    isPending: detailPending,
    error: detailError,
  } = useQuery({
    queryKey: areaDetailKey(activeAreaId, actingAsAdmin),
    enabled: isOpen && isEdit,
    refetchOnWindowFocus: false,
    queryFn: () => read<AreaEditPayload>(`/api/v4/areas/${activeAreaId}`),
  });

  // Seed the edit-form fields whenever the detail loads/changes.
  useEffect(() => {
    if (!isOpen || !detail) return;
    setEditTimezone(detail.area.displayTimezone);
    setEditName(detail.area.name);
    setEditAlias(detail.area.slug ?? "");
    setLocState(detail.area.location?.state ?? "");
    setLocPostcode(detail.area.location?.postcode ?? "");
  }, [detail, isOpen]);

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
    if (detail) {
      const ids = [
        detail.area.id,
        detail.area.legacySystemId,
        ...detail.members.flatMap((m) => [m.id, m.legacySystemId]),
      ];
      for (const id of ids)
        if (id != null) void invalidateDevice(queryClient, id);
      queryClient.invalidateQueries({
        queryKey: ["automations", detail.area.id],
      });
    }
  };

  const aliasValid = isValidAlias(alias.trim());
  const editAliasValid = isValidAlias(editAlias.trim());

  const locationError = areaLocationPatchError(
    { state: locState, postcode: locPostcode },
    detail?.area.location ?? null,
  );
  const isAustralian = (detail?.area.location?.country ?? "AU") === "AU";

  const region = useMemo(
    () =>
      nemRegionForLocation({
        country: detail?.area.location?.country ?? "AU",
        state: locState || undefined,
        postcode: locPostcode || undefined,
      }),
    [locState, locPostcode, detail?.area.location?.country],
  );

  if (!isOpen || typeof document === "undefined") return null;

  // ---- create ----------------------------------------------------------------
  const create = async () => {
    const displayName = name.trim();
    if (!displayName) return setError("Give the site a name");
    if (!aliasValid)
      return setError("Shortname: lowercase letters, numbers, hyphens");
    // No "at least one device" gate: a site with no devices is first-class since the
    // device→0..1-area change, and creating one THEN moving devices in (here, or from a device's own
    // settings) is the natural order when the devices are currently somewhere else.
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
      await cacheSavedAreaDetail(
        queryClient,
        activeAreaId,
        actingAsAdmin,
        body as AreaEditPayload,
      );
      toast.success(successMsg);
      afterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Archive the site.
   *
   * The server refuses while a dashboard, automation or derivation still references the area, and
   * NAMES them. That refusal is worth surfacing in full — but it must not be a dead end: archiving
   * a site a dashboard happens to reference is an ordinary thing to want, and archiving is
   * reversible (the status goes straight back to active). So a refusal offers `force`, and the
   * button that offers it says what it is doing.
   */
  const del = async (force = false) => {
    if (!activeAreaId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v4/areas/${activeAreaId}${force ? "?force=true" : ""}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const named = reliedUponMessage(body);
        setBlockedBy(named);
        setError(named ?? body?.error ?? "Could not delete");
        return;
      }
      setBlockedBy(null);
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
   * 🛑 Order is NOT significant. The array index used to become `area_members.ordinal`; with one
   * area per device there is no membership row left to carry an order, and the server treats the
   * list as a SET. The edit still applies to the loaded order rather than rebuilding a set, because
   * that keeps the diff the user sees minimal — not because the order means anything.
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
    "w-full rounded-md border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-ink-strong placeholder:text-ink-disabled";

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[10000] bg-scrim backdrop-blur-sm"
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div className="pointer-events-none fixed inset-0 z-[10001] flex items-center justify-center px-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={isEdit ? "Area settings" : "New site"}
          className="pointer-events-auto flex max-h-[85vh] w-full max-w-[520px] flex-col rounded-lg border border-line bg-surface-overlay shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-line px-6 py-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Layers className="h-5 w-5 text-assist" />
              {isEdit ? "Area settings" : "New site"}
            </h2>
            <button
              aria-label="Close area settings"
              disabled={busy}
              onClick={() => {
                if (!busy) onClose();
              }}
              className="rounded p-1 transition-colors hover:bg-surface-control"
            >
              <X className="h-5 w-5 text-ink-muted" />
            </button>
          </div>

          {isEdit && (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-4 pt-2">
              {(
                ["general", "location", "members", "bindings"] as EditTab[]
              ).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`shrink-0 rounded-t px-3 py-2 text-sm capitalize transition-colors ${
                    tab === t
                      ? "bg-surface-sunken text-ink"
                      : "text-ink-muted hover:text-ink-control"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 overflow-auto px-6 py-4">
            {isEdit && detailPending && (
              <p role="status">Loading area settings…</p>
            )}
            {isEdit && detailError && (
              <p role="alert" className="text-sm text-danger">
                {detailError.message}
              </p>
            )}
            <fieldset
              disabled={busy || (isEdit && (detailPending || !!detailError))}
              className="space-y-4 disabled:opacity-60"
            >
              {/* CREATE MODE */}
              {!isEdit && (
                <>
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
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
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
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
                      <span className="mt-1 block text-xs text-warn">
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
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                      Name
                    </span>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                      Shortname
                    </span>
                    <input
                      value={editAlias}
                      onChange={(e) => setEditAlias(e.target.value)}
                      onBlur={() => setEditAlias(normalizeAlias(editAlias))}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                      Display timezone
                    </span>
                    <select
                      value={editTimezone}
                      onChange={(e) => setEditTimezone(e.target.value)}
                      className={inputCls}
                    >
                      {!TIMEZONE_GROUPS.some((g) =>
                        g.timezones.some((tz) => tz.value === editTimezone),
                      ) && (
                        <option value={editTimezone}>
                          {editTimezone || "Select a timezone…"}
                        </option>
                      )}
                      {TIMEZONE_GROUPS.map((group) => (
                        <optgroup key={group.region} label={group.region}>
                          {group.timezones.map((tz) => (
                            <option key={tz.value} value={tz.value}>
                              {tz.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <span className="mt-2 block text-xs text-ink-muted">
                      Used for displayed times and local-time schedules in this
                      area.
                    </span>
                  </label>
                  <div className="flex items-center justify-between border-t border-line pt-3">
                    {confirmDelete ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-ink-secondary">
                          Archive this site?
                        </span>
                        <button
                          onClick={() => del(blockedBy != null)}
                          disabled={busy}
                          className="rounded-md bg-danger-solid px-3 py-1.5 text-sm text-ink hover:bg-danger-solid-hover disabled:opacity-50"
                        >
                          {blockedBy ? "Archive anyway" : "Archive"}
                        </button>
                        <button
                          onClick={() => {
                            setConfirmDelete(false);
                            // Clear the escalation too, or a later archive of a DIFFERENT site would
                            // open already showing "Archive anyway" and force on the first click.
                            setBlockedBy(null);
                            setError(null);
                          }}
                          className="text-sm text-ink-muted hover:text-ink"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(true)}
                        className="flex items-center gap-1.5 text-sm text-danger hover:text-danger-ink"
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
                            displayTimezone: editTimezone,
                          },
                          "Saved",
                        )
                      }
                      disabled={
                        busy ||
                        !editName.trim() ||
                        !editAliasValid ||
                        !isValidTimezone(editTimezone)
                      }
                      className="rounded-md bg-accent px-5 py-2 text-sm text-ink hover:bg-accent-hover disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </>
              )}

              {/* EDIT: LOCATION */}
              {isEdit && tab === "location" && (
                <>
                  <p className="text-xs text-ink-faint">
                    A site&apos;s location derives its NEM grid region (for the
                    Local Grid card).
                  </p>
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                      State / territory
                    </span>
                    {!isAustralian ? (
                      <input
                        value={locState}
                        onChange={(e) => setLocState(e.target.value)}
                        className={inputCls}
                      />
                    ) : (
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
                    )}
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                      Postcode (optional)
                    </span>
                    <input
                      inputMode={isAustralian ? "numeric" : "text"}
                      maxLength={isAustralian ? 4 : undefined}
                      value={locPostcode}
                      onChange={(e) => setLocPostcode(e.target.value)}
                      placeholder="e.g. 3460"
                      className={inputCls}
                    />
                  </label>
                  <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <MapPin className="h-3.5 w-3.5" />
                    {region
                      ? `NEM region: ${nemRegionShortLabel(region)}`
                      : "Off-NEM / no region derived"}
                  </div>
                  {locationError && (
                    <p role="alert" className="text-sm text-danger">
                      {locationError}
                    </p>
                  )}
                  <div className="flex justify-end border-t border-line pt-3">
                    <button
                      onClick={() =>
                        patchArea(
                          {
                            location: {
                              state: locState || "",
                              postcode: locPostcode.trim() || "",
                            },
                          },
                          "Saved location",
                        )
                      }
                      disabled={busy || !!locationError}
                      className="rounded-md bg-accent px-5 py-2 text-sm text-ink hover:bg-accent-hover disabled:opacity-50"
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

              {error && (
                <p
                  role="alert"
                  className="whitespace-pre-line text-sm text-danger"
                >
                  {error}
                </p>
              )}
            </fieldset>
          </div>

          {/* CREATE footer */}
          {!isEdit && (
            <div className="flex justify-end gap-3 border-t border-line px-6 py-4">
              <button
                onClick={() => {
                  if (!busy) onClose();
                }}
                disabled={busy}
                className="rounded-md border border-line-strong px-4 py-2 text-ink-secondary hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={create}
                disabled={busy || !name.trim() || !aliasValid}
                className="min-w-[100px] rounded-md bg-accent px-6 py-2 text-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create site"}
              </button>
            </div>
          )}
          {isEdit && (
            <div className="flex justify-end border-t border-line px-6 py-3">
              <button
                onClick={() => {
                  if (!busy) onClose();
                }}
                className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink-secondary hover:text-ink"
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
