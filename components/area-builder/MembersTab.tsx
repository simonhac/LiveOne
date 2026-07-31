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
  const addable = candidates.filter((c) => c.id && !memberIds.has(c.id));
  // "An area needs at least one device" counts only the members a client may actually remove.
  const removable = members.filter((m) => m.vendor !== "helper").length;

  return (
    <div className="space-y-4">
      <div>
        <span className="mb-2 block text-xs uppercase tracking-wide text-gray-500">
          Member devices ({members.length})
        </span>
        {members.length === 0 ? (
          <p className="text-sm text-gray-500">
            No devices yet — add at least one below.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {members.map((m) => {
              const isHelper = m.vendor === "helper";
              const isLocked = m.id === lockedId;
              const isLast = !isHelper && removable <= 1;
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between rounded-md border border-gray-700 bg-gray-900 px-3 py-2"
                >
                  <span className="flex items-center gap-2 text-sm text-gray-100">
                    {isHelper ? (
                      <Wand2 className="h-4 w-4 text-purple-400" />
                    ) : (
                      <Cpu className="h-4 w-4 text-gray-500" />
                    )}
                    {m.name}
                    <span className="text-xs text-gray-600">
                      ID: {m.legacySystemId}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(m.id)}
                    disabled={busy || isHelper || isLocked || isLast}
                    title={
                      isHelper
                        ? "Derived device — managed automatically by this site"
                        : isLocked
                          ? "The device this site was created from"
                          : isLast
                            ? "An area needs at least one device"
                            : "Remove device"
                    }
                    className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-700 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
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
        <span className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500">
          <Plus className="h-3.5 w-3.5" />
          Add a device
        </span>
        <select
          value=""
          disabled={busy || addable.length === 0}
          onChange={(e) => {
            if (e.target.value) onAdd(e.target.value as DeviceId);
          }}
          className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
        >
          <option value="">
            {addable.length === 0
              ? "No more devices available"
              : "Select a device…"}
          </option>
          {addable.map((c) => (
            <option key={c.id} value={c.id!}>
              {c.name} (ID: {c.legacySystemId})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
