"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Play, RefreshCw, Square } from "lucide-react";
import { queryKeys } from "@/lib/queries/keys";
import {
  measurementMsOf,
  pointIdOf,
  teslaChargeControlTargets,
} from "@/lib/control/point-ref";
import { describeDecline } from "@/lib/control/decline-copy";
import type { PointActionName } from "@/lib/control/point-control";
import { getEvStatus, getEvStatusWords } from "@/lib/vendors/tesla/status";
import ControlNotice, {
  type ControlNoticeValue,
} from "@/components/ControlNotice";
import TeslaChargeLimits from "@/components/TeslaChargeLimits";
import CommandActivityLog from "@/components/CommandActivityLog";

interface LatestValue {
  value: number | string | boolean;
  measurementTime?: string | Date;
  /** The source point's `pt_` TypeID — what the v4 action route is addressed by. */
  pointReference?: string;
}

/** One button press, resolved to a point action. */
type ChargeAction = {
  /** Pending-state discriminator (was the legacy command string). */
  key: "start" | "stop" | "limit" | "amps";
  /** The target point's `pt_` TypeID. */
  pt: string;
  action: PointActionName;
  value?: number;
};

interface TeslaControlDialogProps {
  systemId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latest: Record<string, LatestValue | null> | null;
  /**
   * The `ar_` TypeID of the area this tile was served as — the automations resource is
   * area-scoped. Absent (a device-subject tile, or the prop-only card gallery) ⇒ no limits block.
   */
  areaId?: string | null;
}

function num(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): number | null {
  const v = latest?.[path]?.value;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const p = parseFloat(v);
    return isNaN(p) ? null : p;
  }
  return null;
}

function str(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): string | null {
  const v = latest?.[path]?.value;
  return typeof v === "string" ? v : v == null ? null : String(v);
}

// Sensible UI ceiling for home AC charging; the vehicle clamps to its own max.
const AMPS_MAX = 48;

/** Data older than this on open triggers a background refresh — the 2-min charging poll cadence. */
const STALE_ON_OPEN_MS = 120_000;

/** "as of…" words for the status line. Null when there is nothing to date. */
function freshnessWords(ms: number | null, nowMs: number): string | null {
  if (ms == null) return null;
  const age = Math.max(0, nowMs - ms);
  if (age < 60_000) return "just now";
  const min = Math.round(age / 60_000);
  if (min < 120) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

/**
 * Compact Tesla charge-control dialog (opened from the cog on the Tesla card).
 * Start/stop charging, set the charge limit (50–100%), and set the charging amps.
 *
 * Each action posts to the generic command plane, `POST /api/v4/points/{pt_}/action`
 * `{action, value?}`, and then refetches the dashboard. The target `pt_` ids come from the
 * `pointReference` the latest-values map already carries — nothing is hardcoded.
 *
 * ## Trust rules, learned from the first real-world session
 *
 * - **The dialog's picture of the car can be minutes stale** (idle polls are ~12 min), so the
 *   status line carries its own age, opening on stale data asks for a fresh read
 *   (`POST …/refresh`), and Start/Stop are NEVER disabled off that picture — a car that
 *   auto-started charging on plug-in must not lock the user out of Stop because KV still says
 *   Disconnected.
 * - **A benign vendor decline is reassurance, not an error**: `200 {ok:false, reason}` renders
 *   as a calm informational notice via `describeDecline` ("The car says it's already
 *   charging."), never destructive red. The route re-polls on declines too, and the delayed
 *   invalidate below pulls the corrected state in without waiting for the 30 s tick.
 * - **One definition of "charging"** — `getEvStatus`, in which `Starting` counts — shared by
 *   the status line, the limits block and the evaluator, so the dialog never argues with
 *   itself.
 *
 * Two expected degradations, neither of which gets a bypass or a legacy-route fallback:
 * - a MISSING KV entry (the new `ev.charge/active` point before the device's first poll on the
 *   post-deploy code) leaves its target null, which disables Start/Stop;
 * - a PRESENT entry whose server-side `points.control` is still NULL gets the route's 400
 *   "Point is not controllable", surfaced inline by the error notice. Both self-heal on the
 *   next poll (≤12 min idle / 2 min charging) via the mint drift-heal.
 */
export default function TeslaControlDialog({
  systemId,
  open,
  onOpenChange,
  latest,
  areaId,
}: TeslaControlDialogProps) {
  const queryClient = useQueryClient();

  // The three controllable points, resolved from the payload's own point identity.
  const targets = teslaChargeControlTargets(latest);

  const chargingState = str(latest, "ev.charge/state");
  const shift = str(latest, "ev/shift");
  const engaged = num(latest, "ev.charge/engaged");
  const evStatus = getEvStatus({
    shift,
    chargingState,
    // Only decides unplugged-vs-idle; read it so this call means the same thing as the tile's.
    pluggedIn: engaged == null ? null : engaged !== 0,
  });
  const isCharging = evStatus === "charging";
  const currentLimit = num(latest, "ev.charge.limit/soc");
  const currentAmps = num(latest, "ev.charge.limit/current");
  const stateMs = measurementMsOf(latest, "ev.charge/state");

  const [limit, setLimit] = useState<number>(
    currentLimit != null ? Math.round(currentLimit) : 80,
  );
  const [amps, setAmps] = useState<number>(
    currentAmps != null ? Math.round(currentAmps) : 16,
  );
  const [notice, setNotice] = useState<ControlNoticeValue | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Non-null while a background refresh is in flight: the stateMs we saw when we asked.
  const [refreshingFrom, setRefreshingFrom] = useState<number | null>(null);

  // Adopt a CHANGED server value into a slider; leave the user's in-progress adjustment alone
  // when the server merely re-reported the same number.
  const lastServerLimit = useRef(currentLimit);
  useEffect(() => {
    if (currentLimit != null && currentLimit !== lastServerLimit.current) {
      setLimit(Math.round(currentLimit));
    }
    lastServerLimit.current = currentLimit;
  }, [currentLimit]);
  const lastServerAmps = useRef(currentAmps);
  useEffect(() => {
    if (currentAmps != null && currentAmps !== lastServerAmps.current) {
      setAmps(Math.round(currentAmps));
    }
    lastServerAmps.current = currentAmps;
  }, [currentAmps]);

  // Timers for the delayed post-command/post-refresh invalidates; cleared on unmount.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    },
    [],
  );

  /**
   * Pull the re-poll's result in ahead of the 30 s refetch tick. The confirmation poll takes a
   * few seconds end-to-end (vendor read → ingest → KV), so one early invalidate and one
   * backstop.
   */
  function scheduleDataRefresh() {
    for (const delay of [6_000, 15_000]) {
      timersRef.current.push(
        setTimeout(() => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.data(systemId),
          });
        }, delay),
      );
    }
  }

  // Opening on stale data → ask for a fresh read and say so. One shot per open.
  useEffect(() => {
    if (!open) {
      setRefreshingFrom(null);
      setNotice(null);
      return;
    }
    if (!targets.active) return;
    const ageMs = stateMs == null ? Infinity : Date.now() - stateMs;
    if (ageMs <= STALE_ON_OPEN_MS) return;
    setRefreshingFrom(stateMs ?? 0);
    void fetch(`/api/v4/points/${targets.active}/refresh`, {
      method: "POST",
    }).catch(() => {
      // Best-effort: the regular poll cadence still applies.
    });
    scheduleDataRefresh();
    timersRef.current.push(setTimeout(() => setRefreshingFrom(null), 45_000));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open, on purpose
  }, [open]);

  // Fresh data arrived → the "updating…" cue has done its job.
  useEffect(() => {
    if (refreshingFrom != null && stateMs != null && stateMs > refreshingFrom) {
      setRefreshingFrom(null);
    }
  }, [stateMs, refreshingFrom]);

  const mutation = useMutation({
    mutationFn: async ({ pt, action, value }: ChargeAction) => {
      const response = await fetch(`/api/v4/points/${pt}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          value !== undefined ? { action, value } : { action },
        ),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Command failed");
      }
      return data as { ok: boolean; reason: string | null };
    },
    onMutate: ({ key }) => {
      setNotice(null);
      setPending(key);
    },
    onSuccess: async (data, variables) => {
      // A benign vendor decline is a 200 with ok:false plus a reason (Tesla answers
      // "not_charging" when you stop an idle charge). It means the car was already where the
      // user wanted it — reassure, never alarm.
      if (!data.ok) {
        setNotice({
          tone: "info",
          text: describeDecline(variables.action, data.reason).text,
        });
      }
      // The route re-polled either way (a decline proves our view was stale) — pull the
      // confirmed state in, and let the activity log show the press.
      scheduleDataRefresh();
      await queryClient.invalidateQueries({
        queryKey: queryKeys.data(systemId),
      });
      if (targets.active) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.commands(targets.active),
        });
      }
    },
    onError: (err) =>
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Command failed",
      }),
    onSettled: () => setPending(null),
  });

  const busy = mutation.isPending;
  const freshness = freshnessWords(stateMs, Date.now());
  const statusText = chargingState
    ? getEvStatusWords(evStatus).join(" ")
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Charging controls</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <span>{statusText ?? "Tesla charging"}</span>
            {freshness && (
              <span className="text-xs text-gray-500">· as of {freshness}</span>
            )}
            {refreshingFrom != null && (
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <RefreshCw className="h-3 w-3 animate-spin" />
                updating…
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          {/* Start / Stop — deliberately NOT gated on the (possibly stale) charging state:
              a redundant press is a benign decline plus the re-poll that heals the staleness. */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy || !targets.active}
              onClick={() =>
                mutation.mutate({
                  key: "start",
                  pt: targets.active as string,
                  action: "turn_on",
                })
              }
            >
              {pending === "start" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Start
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy || !targets.active}
              onClick={() =>
                mutation.mutate({
                  key: "stop",
                  pt: targets.active as string,
                  action: "turn_off",
                })
              }
            >
              {pending === "stop" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Square className="mr-2 h-4 w-4" />
              )}
              Stop
            </Button>
          </div>

          <ControlNotice notice={notice} onDismiss={() => setNotice(null)} />

          {/* Charge limit */}
          <div className="space-y-2">
            <Label htmlFor="tesla-limit">Charge limit: {limit}%</Label>
            <div className="flex items-center gap-3">
              <input
                id="tesla-limit"
                type="range"
                min={50}
                max={100}
                step={1}
                value={limit}
                disabled={busy}
                onChange={(e) => setLimit(parseInt(e.target.value, 10))}
                className="flex-1 accent-green-600"
              />
              <Button
                size="sm"
                disabled={
                  busy ||
                  limit === Math.round(currentLimit ?? -1) ||
                  !targets.limitSoc
                }
                onClick={() =>
                  mutation.mutate({
                    key: "limit",
                    pt: targets.limitSoc as string,
                    action: "set_value",
                    value: limit,
                  })
                }
              >
                {pending === "limit" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Set"
                )}
              </Button>
            </div>
          </div>

          {/* Charging amps */}
          <div className="space-y-2">
            <Label htmlFor="tesla-amps">Charging current: {amps} A</Label>
            <div className="flex items-center gap-3">
              <input
                id="tesla-amps"
                type="range"
                min={0}
                max={AMPS_MAX}
                step={1}
                value={amps}
                disabled={busy}
                onChange={(e) => setAmps(parseInt(e.target.value, 10))}
                className="flex-1 accent-green-600"
              />
              <Button
                size="sm"
                disabled={
                  busy ||
                  amps === Math.round(currentAmps ?? -1) ||
                  !targets.limitAmps
                }
                onClick={() =>
                  mutation.mutate({
                    key: "amps",
                    pt: targets.limitAmps as string,
                    action: "set_value",
                    value: amps,
                  })
                }
              >
                {pending === "amps" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Set"
                )}
              </Button>
            </div>
          </div>

          {/* Stop after… — shares the dialog's one getEvStatus answer, so `Starting` counts as
              charging here exactly as it does for the evaluator. */}
          <TeslaChargeLimits
            areaId={areaId ?? null}
            activePt={targets.active}
            addedPt={pointIdOf(latest, "ev.charge/added")}
            counterKwh={num(latest, "ev.charge/added")}
            isCharging={isCharging}
          />

          <CommandActivityLog pt={targets.active} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
