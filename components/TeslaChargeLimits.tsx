"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";
import { queryKeys } from "@/lib/queries/keys";
import { chargeAutomationsQuery } from "@/lib/queries/automations";
import {
  compareChargeLimits,
  describeChargeLimit,
  formatChargeLimitLine,
  selectChargeLimits,
  type ChargeLimitDescription,
  type ChargeLimitJson,
} from "@/lib/automations/progress";

interface TeslaChargeLimitsProps {
  /** The `ar_` TypeID of the area the tile was served as — null ⇒ the block does not render. */
  areaId: string | null;
  /** `ev.charge/active` — the switch a limit turns off, and what scopes the area's list to this car. */
  activePt: string | null;
  /** `ev.charge/added` — the kWh counter a limit follows. */
  addedPt: string | null;
  /** The counter's latest value, for the "so far" figure. */
  counterKwh: number | null;
  /** Is the car charging right now (`getEvStatus`, so `Starting` counts)? Gates "this session". */
  isCharging: boolean;
}

/** Mirrors `parseThreshold` (`lib/automations/types.ts`): absent, or finite and > 0. */
function parseField(raw: string): { ok: true; value?: number } | { ok: false } {
  const t = raw.trim();
  if (t === "") return { ok: true };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}

function targetWords(minutes?: number, kwh?: number): string {
  const parts: string[] = [];
  if (minutes != null) parts.push(`${minutes} min`);
  if (kwh != null) parts.push(`${kwh} kWh`);
  return parts.join(" or ");
}

function timeWords(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The status sentence under a rule's targets — the honest wording for each evaluator state. */
function stateWords(
  row: ChargeLimitJson,
  desc: ChargeLimitDescription,
): string {
  switch (desc.state) {
    case "armed":
      return formatChargeLimitLine(desc) ?? "Armed";
    case "waiting":
      return row.mode === "standing"
        ? "Waiting for the next charge"
        : "Arming…";
    case "stopped": {
      const t = timeWords(row.lastTriggeredAt);
      return t ? `Stopped charging at ${t}` : "Stopped charging";
    }
    case "off":
      return "Disabled";
  }
}

/**
 * The "stop after…" block inside the charge-control dialog: create, show, edit and cancel a
 * charge limit for THIS car.
 *
 * A limit is one `automations` row — trigger `{charge-session, source: ev.charge/added,
 * afterMinutes?, afterKwh?}`, action `turn_off` on `ev.charge/active` — evaluated by the minutely
 * cron. Everything this component renders is behind the dialog's existing owner-only gate; the
 * server re-gates every create and patch on device OWNERSHIP (`checkReferences →
 * requireDeviceAccess({requireOwner:true})`), so there is deliberately no second client-side
 * authorization answer here.
 *
 * Three evaluator behaviours the copy has to be honest about, rather than paper over:
 *  - **arming is asynchronous** — a new rule reads "Arming…" until the next cron tick sees the car
 *    charging. We never fake progress before there is a baseline to measure from;
 *  - **a `once` with no live session self-disables** on the next tick, so "this session" is
 *    offered only while the car is actually charging;
 *  - **editing thresholds re-baselines** (the PATCH route nulls `armed_at`/`armed_context`), so
 *    "so far" restarts from zero — said out loud in the edit affordance.
 */
export default function TeslaChargeLimits({
  areaId,
  activePt,
  addedPt,
  counterKwh,
  isCharging,
}: TeslaChargeLimitsProps) {
  const queryClient = useQueryClient();
  const [minutes, setMinutes] = useState("");
  const [kwh, setKwh] = useState("");
  const [mode, setMode] = useState<"once" | "standing">("once");
  const [editing, setEditing] = useState<string | null>(null);
  const [editMinutes, setEditMinutes] = useState("");
  const [editKwh, setEditKwh] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const list = useQuery({
    ...chargeAutomationsQuery(areaId),
    enabled: !!areaId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.automations(areaId ?? ""),
    });

  /**
   * One mutation for all four verbs. `key` is the pending-state discriminator (the dialog's
   * idiom); a 422/403 body's `error` string lands in the inline Alert rather than being thrown
   * past it.
   */
  const mutation = useMutation({
    mutationFn: async ({
      url,
      method,
      body,
    }: {
      key: string;
      url: string;
      method: "POST" | "PATCH" | "DELETE";
      body?: unknown;
    }) => {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    },
    onMutate: ({ key }) => {
      setError(null);
      setPending(key);
    },
    onSuccess: async () => {
      await invalidate();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Request failed"),
    onSettled: () => setPending(null),
  });

  const busy = mutation.isPending;

  if (!areaId) return null;

  const rows = selectChargeLimits(list.data?.automations ?? [], activePt);
  const nowMs = Date.now();
  const described = rows
    .map((row) => ({
      row,
      desc: describeChargeLimit(
        row,
        counterKwh != null ? { valueKwh: counterKwh } : null,
        addedPt,
        nowMs,
      ),
    }))
    .sort((a, b) =>
      compareChargeLimits(
        { state: a.desc.state, name: a.row.name },
        { state: b.desc.state, name: b.row.name },
      ),
    );
  // Rows the server could not parse (`wire.ts` nulls what it cannot read): listed so they can be
  // DELETED, excluded from limit maths. A null ACTION cannot be scoped to a car at all, so those
  // are shown regardless; a readable action still has to be this car's.
  const unreadable = (list.data?.automations ?? []).filter(
    (r) =>
      r.action === null ||
      (r.trigger === null && r.action.pointId === activePt),
  );

  // "This session" is a promise the evaluator only keeps while a session exists — a `once` armed
  // against an idle car self-disables on the next tick. So an idle car falls back to a standing
  // rule rather than offering a control that quietly evaporates.
  const effectiveMode = mode === "once" && !isCharging ? "standing" : mode;

  const parsedMinutes = parseField(minutes);
  const parsedKwh = parseField(kwh);
  const canCreate =
    !!addedPt &&
    !!activePt &&
    parsedMinutes.ok &&
    parsedKwh.ok &&
    (parsedMinutes.value !== undefined || parsedKwh.value !== undefined);

  function createLimit() {
    if (!canCreate || !parsedMinutes.ok || !parsedKwh.ok) return;
    const trigger: Record<string, unknown> = {
      kind: "charge-session",
      source: { kind: "point", pointId: addedPt },
    };
    if (parsedMinutes.value !== undefined)
      trigger.afterMinutes = parsedMinutes.value;
    if (parsedKwh.value !== undefined) trigger.afterKwh = parsedKwh.value;
    mutation.mutate(
      {
        key: "create",
        url: "/api/v4/automations",
        method: "POST",
        body: {
          areaId,
          mode: effectiveMode,
          trigger,
          action: {
            kind: "point-action",
            pointId: activePt,
            action: "turn_off",
          },
        },
      },
      {
        onSuccess: () => {
          setMinutes("");
          setKwh("");
        },
      },
    );
  }

  function saveEdit(row: ChargeLimitJson) {
    const m = parseField(editMinutes);
    const k = parseField(editKwh);
    if (!m.ok || !k.ok) return;
    if (m.value === undefined && k.value === undefined) return;
    if (!row.trigger) return;
    const trigger: Record<string, unknown> = {
      kind: "charge-session",
      // Same source — this is a whole-object replace, not a merge.
      source: row.trigger.source,
    };
    if (m.value !== undefined) trigger.afterMinutes = m.value;
    if (k.value !== undefined) trigger.afterKwh = k.value;
    mutation.mutate(
      {
        key: `edit:${row.id}`,
        url: `/api/v4/automations/${row.id}`,
        method: "PATCH",
        body: { trigger },
      },
      { onSuccess: () => setEditing(null) },
    );
  }

  return (
    <div className="space-y-3 border-t border-gray-700 pt-4">
      <div className="flex items-baseline justify-between">
        <Label className="text-sm">Stop charging after…</Label>
        {list.isLoading && (
          <Loader2 className="h-3 w-3 animate-spin text-gray-500" />
        )}
      </div>

      {/* Existing limits */}
      {described.length > 0 && (
        <ul className="space-y-2">
          {described.map(({ row, desc }) => (
            <li
              key={row.id}
              className="rounded border border-gray-700 px-3 py-2 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">
                    {targetWords(
                      row.trigger?.afterMinutes,
                      row.trigger?.afterKwh,
                    )}
                    <span className="ml-2 text-xs text-gray-400">
                      {row.mode === "once" ? "this session" : "every charge"}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400">
                    {stateWords(row, desc)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {row.mode === "standing" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        mutation.mutate({
                          key: `toggle:${row.id}`,
                          url: `/api/v4/automations/${row.id}`,
                          method: "PATCH",
                          // Always the OPPOSITE value — a same-value write is a deliberate
                          // server-side no-op for arming, so never send one as churn.
                          body: { enabled: !row.enabled },
                        })
                      }
                    >
                      {pending === `toggle:${row.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : row.enabled ? (
                        "Pause"
                      ) : (
                        "Resume"
                      )}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !row.trigger}
                    onClick={() => {
                      setEditing(editing === row.id ? null : row.id);
                      setEditMinutes(
                        row.trigger?.afterMinutes != null
                          ? String(row.trigger.afterMinutes)
                          : "",
                      );
                      setEditKwh(
                        row.trigger?.afterKwh != null
                          ? String(row.trigger.afterKwh)
                          : "",
                      );
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Cancel limit"
                    disabled={busy}
                    onClick={() =>
                      mutation.mutate({
                        key: `delete:${row.id}`,
                        url: `/api/v4/automations/${row.id}`,
                        method: "DELETE",
                      })
                    }
                  >
                    {pending === `delete:${row.id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              {editing === row.id && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      value={editMinutes}
                      placeholder="min"
                      disabled={busy}
                      onChange={(e) => setEditMinutes(e.target.value)}
                      className="h-8"
                    />
                    <Input
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={editKwh}
                      placeholder="kWh"
                      disabled={busy}
                      onChange={(e) => setEditKwh(e.target.value)}
                      className="h-8"
                    />
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => saveEdit(row)}
                    >
                      {pending === `edit:${row.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "Save"
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-gray-500">
                    Changing a limit re-arms it on the next check, so “so far”
                    starts again from zero.
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {unreadable.length > 0 && (
        <ul className="space-y-2">
          {unreadable.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between rounded border border-gray-700 px-3 py-2 text-sm text-gray-400"
            >
              <span>Unreadable rule</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Delete rule"
                disabled={busy}
                onClick={() =>
                  mutation.mutate({
                    key: `delete:${row.id}`,
                    url: `/api/v4/automations/${row.id}`,
                    method: "DELETE",
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Create */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={minutes}
            placeholder="minutes"
            disabled={busy || !addedPt || !activePt}
            onChange={(e) => setMinutes(e.target.value)}
            className="h-8"
          />
          <Input
            type="number"
            min={0.1}
            step={0.1}
            value={kwh}
            placeholder="kWh"
            disabled={busy || !addedPt || !activePt}
            onChange={(e) => setKwh(e.target.value)}
            className="h-8"
          />
          <Button size="sm" disabled={busy || !canCreate} onClick={createLimit}>
            {pending === "create" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Add"
            )}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={effectiveMode === "once" ? "default" : "outline"}
            disabled={busy || !isCharging}
            onClick={() => setMode("once")}
            className="flex-1"
          >
            This session
          </Button>
          <Button
            size="sm"
            variant={effectiveMode === "standing" ? "default" : "outline"}
            disabled={busy}
            onClick={() => setMode("standing")}
            className="flex-1"
          >
            Every charge
          </Button>
        </div>
        {!isCharging && (
          <p className="text-xs text-gray-500">
            The car isn’t charging — a this-session limit would cancel itself,
            so only a standing rule can be set now.
          </p>
        )}
        {(!addedPt || !activePt) && (
          <p className="text-xs text-gray-500">
            Waiting for the car’s charge points to report before a limit can be
            set.
          </p>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
