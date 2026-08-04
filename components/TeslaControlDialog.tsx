"use client";

import { useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, Play, Square } from "lucide-react";
import { queryKeys } from "@/lib/queries/keys";
import { pointIdOf, teslaChargeControlTargets } from "@/lib/control/point-ref";
import { getEvStatus } from "@/lib/vendors/tesla/status";
import TeslaChargeLimits from "@/components/TeslaChargeLimits";

interface LatestValue {
  value: number | string | boolean;
  /** The source point's `pt_` TypeID — what the v4 action route is addressed by. */
  pointReference?: string;
}

/** One button press, resolved to a point action. */
type ChargeAction = {
  /** Pending-state discriminator (was the legacy command string). */
  key: "start" | "stop" | "limit" | "amps";
  /** The target point's `pt_` TypeID. */
  pt: string;
  action: "turn_on" | "turn_off" | "set_value";
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

/**
 * Compact Tesla charge-control dialog (opened from the cog on the Tesla card).
 * Start/stop charging, set the charge limit (50–100%), and set the charging amps.
 *
 * Each action posts to the generic command plane, `POST /api/v4/points/{pt_}/action`
 * `{action, value?}`, and then refetches the dashboard. The target `pt_` ids come from the
 * `pointReference` the latest-values map already carries — nothing is hardcoded.
 *
 * Two expected degradations, neither of which gets a bypass or a legacy-route fallback:
 * - a MISSING KV entry (the new `ev.charge/active` point before the device's first poll on the
 *   post-deploy code) leaves its target null, which disables Start/Stop;
 * - a PRESENT entry whose server-side `points.control` is still NULL gets the route's 400
 *   "Point is not controllable", surfaced inline by the error Alert below. Both self-heal on the
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
  const isCharging = chargingState === "Charging";
  const currentLimit = num(latest, "ev.charge.limit/soc");
  const currentAmps = num(latest, "ev.charge.limit/current");

  const [limit, setLimit] = useState<number>(
    currentLimit != null ? Math.round(currentLimit) : 80,
  );
  const [amps, setAmps] = useState<number>(
    currentAmps != null ? Math.round(currentAmps) : 16,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

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
      setError(null);
      setPending(key);
    },
    onSuccess: async (data) => {
      // A benign vendor decline is a 200 with ok:false plus a reason (Tesla answers
      // "not_charging" when you stop an idle charge) — inline, never an error.
      if (!data.ok && data.reason) {
        setError(`Tesla declined: ${data.reason}`);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.data(systemId),
      });
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Command failed"),
    onSettled: () => setPending(null),
  });

  const busy = mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Charging controls</DialogTitle>
          <DialogDescription>
            {chargingState ? `Status: ${chargingState}` : "Tesla charging"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          {/* Start / Stop */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy || isCharging || !targets.active}
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
              disabled={busy || !isCharging || !targets.active}
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

          {/* Stop after… — the charge-limit block. `getEvStatus` (not the Start/Stop button's
              `Charging`-only check) is what gates a "this session" limit, because `Starting` is a
              real state the evaluator will arm on. */}
          <TeslaChargeLimits
            areaId={areaId ?? null}
            activePt={targets.active}
            addedPt={pointIdOf(latest, "ev.charge/added")}
            counterKwh={num(latest, "ev.charge/added")}
            isCharging={
              getEvStatus({
                shift: str(latest, "ev/shift"),
                chargingState,
                // Only decides unplugged-vs-idle, neither of which is "charging" — read it
                // anyway so this call means the same thing as the tile's.
                pluggedIn:
                  num(latest, "ev.charge/engaged") == null
                    ? null
                    : num(latest, "ev.charge/engaged") !== 0,
              }) === "charging"
            }
          />

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
