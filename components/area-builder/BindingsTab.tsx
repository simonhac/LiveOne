"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { fetchJson } from "@/lib/queries";
import { ROLE_IDS, ROLES, stemMatchesRole } from "@/lib/roles/registry";
import type {
  AreaBinding,
  DevicePoint,
  DevicePointsResponse,
  MemberChip,
} from "./types";
import { stemOfLogicalPath } from "./types";
import type { PointId } from "@/lib/ids";

/** An editable binding row (a point may be unset until chosen). */
interface Row {
  role: string;
  /** The chosen point's `pt_` TypeID, or null until picked. */
  pointId: PointId | null;
  metricType: string;
}

/**
 * The typed role→point bindings editor (edit mode only). Fetches each member device's points, lets the
 * owner compose an ordered list of role→point edges, and saves the whole list via
 * `PUT /api/v4/areas/{ar_…}/bindings` (a full replace). No bindings = union-default (every member's
 * own points), which is a valid, common state.
 *
 * Two things about the v4 twin that the row list makes visible:
 *  - the rows arrive ordered by (role, metricType, priority) rather than raw insertion `ordinal`, so
 *    the editor now groups by slot. Within a slot the order IS the priority order, which is what the
 *    up/down arrows have always really been editing.
 *  - `priority` is deliberately NOT sent back. The server derives it per (role, metric) slot from array
 *    position, exactly as it did before; re-asserting the loaded values would collide with that counter
 *    the moment a new row joined an existing slot.
 *
 * The member list is passed as `MemberChip`s rather than integers because the points endpoint is still
 * handle-addressed: `legacySystemId` is the fetch key, `name` is the optgroup label, and both come off
 * the area aggregate so an inactive member still appears.
 */
export default function BindingsTab({
  areaId,
  members,
  initialBindings,
  onSaved,
}: {
  areaId: string;
  members: MemberChip[];
  initialBindings: AreaBinding[];
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    initialBindings.map((b) => ({
      role: b.role,
      pointId: b.pointId,
      metricType: b.metricType,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberKey = members.map((m) => m.legacySystemId).join(",");
  const { data: pointsByMember, isPending } = useQuery({
    queryKey: ["area-builder", "points", memberKey],
    enabled: members.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        members.map(async (m) => {
          const resp = await fetchJson<DevicePointsResponse>(
            `/api/device/${m.legacySystemId}/points?showActive=true`,
          );
          return [m.legacySystemId, resp.points] as const;
        }),
      );
      return new Map<number, DevicePoint[]>(entries);
    },
  });

  // Fast lookup: `pt_` id → the point (for metricType + validity). Keyed by the point's own opaque
  // identity, so it no longer depends on the owning device's integer handle.
  const pointById = useMemo(() => {
    const m = new Map<string, DevicePoint>();
    if (!pointsByMember) return m;
    for (const points of pointsByMember.values()) {
      for (const p of points) m.set(p.pointId, p);
    }
    return m;
  }, [pointsByMember]);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) =>
    setRows((rs) => {
      const j = i + dir;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const addRow = () =>
    setRows((rs) => [
      ...rs,
      { role: ROLE_IDS[0], pointId: null, metricType: "" },
    ]);
  const removeRow = (i: number) =>
    setRows((rs) => rs.filter((_, idx) => idx !== i));

  const onPickPoint = (i: number, value: string) => {
    if (!value) {
      setRow(i, { pointId: null, metricType: "" });
      return;
    }
    const p = pointById.get(value);
    if (!p) return;
    setRow(i, { pointId: p.pointId, metricType: p.metricType });
  };

  const save = async () => {
    const complete = rows.filter((r) => r.pointId != null && r.metricType);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v4/areas/${areaId}/bindings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bindings: complete.map((r) => ({
            role: r.role,
            metricType: r.metricType,
            pointId: r.pointId,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Could not save bindings");
        return;
      }
      toast.success("Saved bindings");
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (isPending && members.length > 0) {
    return <p className="text-sm text-gray-500">Loading points…</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Bindings select which points a role reads. Leave empty to default to the
        union of every member device&apos;s own points.
      </p>

      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r, i) => {
            const selectedPointId = r.pointId ?? "";
            return (
              <li
                key={i}
                className="flex items-center gap-2 rounded-md border border-gray-700 bg-gray-900 px-2 py-2"
              >
                <select
                  value={r.role}
                  onChange={(e) => setRow(i, { role: e.target.value })}
                  className="rounded-md border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-gray-100"
                >
                  {ROLE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {ROLES[id].label}
                    </option>
                  ))}
                </select>
                <span className="text-gray-600">→</span>
                <select
                  value={selectedPointId}
                  onChange={(e) => onPickPoint(i, e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-gray-100"
                >
                  <option value="">Select a point…</option>
                  {members.map((m) => {
                    const points = pointsByMember?.get(m.legacySystemId) ?? [];
                    if (points.length === 0) return null;
                    return (
                      <optgroup key={m.id} label={m.name}>
                        {points.map((p) => {
                          const compatible = stemMatchesRole(
                            stemOfLogicalPath(p.logicalPath),
                            r.role as (typeof ROLE_IDS)[number],
                          );
                          return (
                            <option key={p.pointId} value={p.pointId}>
                              {compatible ? "● " : ""}
                              {p.logicalPath} — {p.name}
                            </option>
                          );
                        })}
                      </optgroup>
                    );
                  })}
                </select>
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    className="text-gray-500 hover:text-gray-200 disabled:opacity-20"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === rows.length - 1}
                    className="text-gray-500 hover:text-gray-200 disabled:opacity-20"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-red-400"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300"
      >
        <Plus className="h-4 w-4" />
        Add binding
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex justify-end border-t border-gray-700 pt-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-blue-600 px-5 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save bindings"}
        </button>
      </div>
    </div>
  );
}
