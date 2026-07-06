"use client";

import { Plus, X, Cpu } from "lucide-react";
import type { CandidateSystem } from "./types";

/**
 * The member-devices editor for the Area builder (create + edit modes). Lists the area's current
 * member devices (names joined from `candidate-systems`) with remove buttons, plus an "add device"
 * picker over the candidates not already members. The parent owns the member list + the add/remove
 * side effects (local state in create mode; the `.../devices` endpoints in edit mode).
 */
export default function MembersTab({
  candidates,
  memberIds,
  lockedId,
  busy,
  onAdd,
  onRemove,
}: {
  candidates: CandidateSystem[];
  memberIds: number[];
  /** A member that can't be removed (the seed device in "create from this device"). */
  lockedId?: number;
  busy?: boolean;
  onAdd: (systemId: number) => void;
  onRemove: (systemId: number) => void;
}) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const label = (id: number) => byId.get(id)?.displayName ?? `ID: ${id}`;
  const addable = candidates.filter((c) => !memberIds.includes(c.id));

  return (
    <div className="space-y-4">
      <div>
        <span className="mb-2 block text-xs uppercase tracking-wide text-gray-500">
          Member devices ({memberIds.length})
        </span>
        {memberIds.length === 0 ? (
          <p className="text-sm text-gray-500">
            No devices yet — add at least one below.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {memberIds.map((id) => (
              <li
                key={id}
                className="flex items-center justify-between rounded-md border border-gray-700 bg-gray-900 px-3 py-2"
              >
                <span className="flex items-center gap-2 text-sm text-gray-100">
                  <Cpu className="h-4 w-4 text-gray-500" />
                  {label(id)}
                  <span className="text-xs text-gray-600">ID: {id}</span>
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(id)}
                  disabled={busy || id === lockedId || memberIds.length <= 1}
                  title={
                    id === lockedId
                      ? "The device this site was created from"
                      : memberIds.length <= 1
                        ? "An area needs at least one device"
                        : "Remove device"
                  }
                  className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-700 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
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
            const id = Number(e.target.value);
            if (Number.isInteger(id)) onAdd(id);
          }}
          className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
        >
          <option value="">
            {addable.length === 0
              ? "No more devices available"
              : "Select a device…"}
          </option>
          {addable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} (ID: {c.id})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
