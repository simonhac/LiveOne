"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { fetchJson } from "@/lib/queries";
import { ROLE_IDS, ROLES, stemMatchesRole } from "@/lib/roles/registry";
import type {
  AreaBinding,
  CandidateSystem,
  SystemPoint,
  SystemPointsResponse,
} from "./types";
import { parseReference, stemOfLogicalPath } from "./types";

/** An editable binding row (a point may be unset until chosen). */
interface Row {
  role: string;
  pointSystemId: number | null;
  pointId: number | null;
  metricType: string;
}

const refKey = (ps: number, pid: number) => `${ps}.${pid}`;

/**
 * The typed role→point bindings editor (edit mode only). Fetches each member device's points, lets the
 * owner compose an ordered list of role→point edges, and saves the whole list via
 * `PUT /api/areas/[areaId]/bindings` (ordinal = position). No bindings = union-default (every member's
 * own points), which is a valid, common state.
 */
export default function BindingsTab({
  areaId,
  memberIds,
  candidates,
  initialBindings,
  onSaved,
}: {
  areaId: string;
  memberIds: number[];
  candidates: CandidateSystem[];
  initialBindings: AreaBinding[];
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    initialBindings.map((b) => ({
      role: b.role,
      pointSystemId: b.pointSystemId,
      pointId: b.pointId,
      metricType: b.metricType,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberKey = memberIds.join(",");
  const { data: pointsByMember, isPending } = useQuery({
    queryKey: ["area-builder", "points", memberKey],
    enabled: memberIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        memberIds.map(async (id) => {
          const resp = await fetchJson<SystemPointsResponse>(
            `/api/system/${id}/points?showActive=true`,
          );
          return [id, resp.points] as const;
        }),
      );
      return new Map<number, SystemPoint[]>(entries);
    },
  });

  const nameById = new Map(candidates.map((c) => [c.id, c.displayName]));

  // Fast lookup: "sys.pid" → the point (for metricType + validity).
  const pointByRef = useMemo(() => {
    const m = new Map<string, SystemPoint>();
    if (!pointsByMember) return m;
    for (const [sysId, points] of pointsByMember) {
      for (const p of points) {
        const ref = parseReference(p.reference);
        if (ref && ref.pointSystemId === sysId)
          m.set(refKey(ref.pointSystemId, ref.pointId), p);
      }
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
      { role: ROLE_IDS[0], pointSystemId: null, pointId: null, metricType: "" },
    ]);
  const removeRow = (i: number) =>
    setRows((rs) => rs.filter((_, idx) => idx !== i));

  const onPickPoint = (i: number, value: string) => {
    if (!value) {
      setRow(i, { pointSystemId: null, pointId: null, metricType: "" });
      return;
    }
    const p = pointByRef.get(value);
    const ref = parseReference(value);
    if (!p || !ref) return;
    setRow(i, {
      pointSystemId: ref.pointSystemId,
      pointId: ref.pointId,
      metricType: p.metricType,
    });
  };

  const save = async () => {
    const complete = rows.filter(
      (r) => r.pointSystemId != null && r.pointId != null && r.metricType,
    );
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/areas/${areaId}/bindings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bindings: complete.map((r) => ({
            role: r.role,
            metricType: r.metricType,
            pointSystemId: r.pointSystemId,
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

  if (isPending && memberIds.length > 0) {
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
            const selectedRef =
              r.pointSystemId != null && r.pointId != null
                ? refKey(r.pointSystemId, r.pointId)
                : "";
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
                  value={selectedRef}
                  onChange={(e) => onPickPoint(i, e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-gray-100"
                >
                  <option value="">Select a point…</option>
                  {memberIds.map((sysId) => {
                    const points = pointsByMember?.get(sysId) ?? [];
                    if (points.length === 0) return null;
                    return (
                      <optgroup
                        key={sysId}
                        label={nameById.get(sysId) ?? `ID: ${sysId}`}
                      >
                        {points.map((p) => {
                          const ref = parseReference(p.reference);
                          if (!ref) return null;
                          const compatible = stemMatchesRole(
                            stemOfLogicalPath(p.logicalPath),
                            r.role as (typeof ROLE_IDS)[number],
                          );
                          return (
                            <option
                              key={p.reference}
                              value={refKey(ref.pointSystemId, ref.pointId)}
                            >
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
