"use client";

import { Plus, X, Cpu, Wand2 } from "lucide-react";
import type { CandidateDevice, MemberChip } from "./types";
import type { DeviceId } from "@/lib/ids";

/**
 * The member-devices editor for the Area builder (create + edit modes). Lists the area's current
 * member devices with remove buttons, plus an "add device" picker over the candidates not already
 * members. The parent owns the member list + the side effects (local state in create mode; one
 * `PUT /api/v4/areas/{id}/members` full replace in edit mode).
 *
 * 🛑 The currency is the `dv_` TypeID, because that is what `PUT …/members` takes. Each member carries
 * its own name, so this no longer joins against the candidate list to label a row — which matters:
 * `GET /api/v4/devices` is `activeOnly`, so an inactive member is a member the candidates cannot name.
 *
 * 🛑 A `vendor='helper'` member is SERVER-MANAGED (the battery-provenance writer mints it and binds the
 * blend points onto it) and is the one documented exception to full-replace: the route never evicts it
 * by omission. So it is shown — it really is a member, and its points are bindable — but its remove
 * button is disabled rather than being a button that silently does nothing.
 *
 * 🛑 **Adding is a MOVE and removing is an ORPHANING**, and the copy here has to say so, because
 * neither is visible in this list alone. A device is in at most one area, so picking one out of the
 * "add" list takes it out of the area it is in today — deleting that area's bindings onto its points,
 * which can blank a card on a site the operator is not looking at. So each candidate is labelled with
 * where it currently lives. And removing does not delete a device: it leaves it AMBIENT, in no area,
 * which is a real state — still polled, still aggregated, just with no flow matrix. Emptying an area
 * completely is allowed; the old "an area needs at least one device" rule is gone with the
 * area-of-one.
 */
export default function MembersTab({
  candidates,
  members,
  lockedId,
  busy,
  onAdd,
  onRemove,
}: {
  candidates: CandidateDevice[];
  members: MemberChip[];
  /** A member that can't be removed (the seed device in "create from this device"). */
  lockedId?: DeviceId | null;
  busy?: boolean;
  onAdd: (deviceId: DeviceId) => void;
  onRemove: (deviceId: DeviceId) => void;
}) {
  const memberIds = new Set(members.map((m) => m.id));
  // An OWNERLESS device is ambient by construction (an OpenElectricity NEM region — Home Assistant's
  // `entry_type=SERVICE`). The server refuses to place one, so offering it here would produce a 422
  // the user cannot act on; consumers reference it by id instead.
  const addable = candidates.filter(
    (c) => c.id && !memberIds.has(c.id) && c.ownerUserId !== null,
  );

  return (
    <div className="space-y-4">
      <div>
        <span className="mb-2 block text-xs uppercase tracking-wide text-ink-faint">
          Member devices ({members.length})
        </span>
        {members.length === 0 ? (
          <p className="text-sm text-ink-faint">
            No devices. A site with no devices is allowed — it simply has no
            data of its own until you add one.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {members.map((m) => {
              const isHelper = m.vendor === "helper";
              const isLocked = m.id === lockedId;
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between rounded-md border border-line bg-surface-sunken px-3 py-2"
                >
                  <span className="flex items-center gap-2 text-sm text-ink-strong">
                    {isHelper ? (
                      <Wand2 className="h-4 w-4 text-assist" />
                    ) : (
                      <Cpu className="h-4 w-4 text-ink-faint" />
                    )}
                    {m.name}
                    <span className="text-xs text-ink-disabled">
                      ID: {m.legacySystemId}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(m.id)}
                    disabled={busy || isHelper || isLocked}
                    title={
                      isHelper
                        ? "Derived device — managed automatically by this site"
                        : isLocked
                          ? "The device this site was created from"
                          : "Move out of this site — the device is kept, with no area"
                    }
                    className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-control hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <label className="block">
        <span className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <Plus className="h-3.5 w-3.5" />
          Move a device here
        </span>
        <select
          value=""
          disabled={busy || addable.length === 0}
          onChange={(e) => {
            if (e.target.value) onAdd(e.target.value as DeviceId);
          }}
          className="w-full rounded-md border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-ink-strong disabled:opacity-50"
        >
          <option value="">
            {addable.length === 0
              ? "No more devices available"
              : "Select a device…"}
          </option>
          {addable.map((c) => (
            <option key={c.id} value={c.id!}>
              {c.name} (ID: {c.legacySystemId})
              {c.areaName ? ` — currently in ${c.areaName}` : " — no site"}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-ink-faint">
          A device belongs to one site. Choosing one here moves it out of the
          site it is in now, along with that site&rsquo;s bindings onto its
          points.
        </span>
      </label>
    </div>
  );
}
