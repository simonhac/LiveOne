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

interface LatestValue {
  value: number | string | boolean;
}

type Command =
  | { command: "charge_start" | "charge_stop" }
  | { command: "set_charge_limit"; percent: number }
  | { command: "set_charging_amps"; amps: number };

interface TeslaControlDialogProps {
  systemId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latest: Record<string, LatestValue | null> | null;
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
 * Each action posts to /api/systems/{id}/tesla/command and refetches the dashboard.
 */
export default function TeslaControlDialog({
  systemId,
  open,
  onOpenChange,
  latest,
}: TeslaControlDialogProps) {
  const queryClient = useQueryClient();

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
    mutationFn: async (cmd: Command) => {
      const response = await fetch(`/api/systems/${systemId}/tesla/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Command failed");
      }
      return data as { success: boolean; reason: string | null };
    },
    onMutate: (cmd) => {
      setError(null);
      setPending(cmd.command);
    },
    onSuccess: async (data) => {
      // Tesla can return success:false with a benign reason (e.g. "not_charging").
      if (!data.success && data.reason) {
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
              disabled={busy || isCharging}
              onClick={() => mutation.mutate({ command: "charge_start" })}
            >
              {pending === "charge_start" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Start
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy || !isCharging}
              onClick={() => mutation.mutate({ command: "charge_stop" })}
            >
              {pending === "charge_stop" ? (
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
                disabled={busy || limit === Math.round(currentLimit ?? -1)}
                onClick={() =>
                  mutation.mutate({
                    command: "set_charge_limit",
                    percent: limit,
                  })
                }
              >
                {pending === "set_charge_limit" ? (
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
                disabled={busy || amps === Math.round(currentAmps ?? -1)}
                onClick={() =>
                  mutation.mutate({ command: "set_charging_amps", amps })
                }
              >
                {pending === "set_charging_amps" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Set"
                )}
              </Button>
            </div>
          </div>

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
