"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, ExternalLink, Car } from "lucide-react";

interface VehicleOption {
  id: string;
  displayName: string;
  vin: string;
}

interface CompleteResponse {
  success?: boolean;
  systemId?: number;
  needsSelection?: boolean;
  selectionToken?: string;
  vehicles?: VehicleOption[];
  error?: string;
}

interface TeslaConnectFlowProps {
  /** Called with the new system id once a vehicle has been connected. */
  onConnected: (systemId: number) => void;
  /** Whether the surrounding dialog is busy (disables actions). */
  disabled?: boolean;
}

type Step = "idle" | "awaiting-paste" | "selecting";

/**
 * In-dialog Tesla Owner API onboarding (redirect + paste-back).
 *
 * 1. "Connect with Tesla" opens Tesla's login in a new tab (popup opened synchronously
 *    on click to dodge popup blockers, then pointed at the auth URL once we have it).
 * 2. The user logs in on Tesla's own page, lands on a blank "Page Not Found"
 *    (auth.tesla.com/void/callback?code=...), and pastes that URL back here.
 * 3. We exchange it server-side; if the account has multiple vehicles, we show a picker.
 */
export default function TeslaConnectFlow({
  onConnected,
  disabled,
}: TeslaConnectFlowProps) {
  const [step, setStep] = useState<Step>("idle");
  const [pastedUrl, setPastedUrl] = useState("");
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [selectionToken, setSelectionToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectMutation = useMutation({
    mutationFn: async () => {
      // Open the popup synchronously (still inside the click handler) so it isn't blocked.
      const popup = window.open("", "_blank");

      const response = await fetch("/api/auth/tesla/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok || !data.authUrl) {
        popup?.close();
        throw new Error(data.error || "Failed to start Tesla login");
      }

      if (popup) {
        popup.location.href = data.authUrl as string;
      } else {
        // Popup blocked — navigate the current tab as a fallback.
        window.location.href = data.authUrl as string;
      }
      return data.authUrl as string;
    },
    onMutate: () => setError(null),
    onSuccess: () => setStep("awaiting-paste"),
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Failed to start Tesla login",
      ),
  });

  const completeMutation = useMutation({
    mutationFn: async (
      payload:
        | { callbackUrl: string }
        | { selectionToken: string; vehicleId: string },
    ): Promise<CompleteResponse> => {
      const response = await fetch("/api/auth/tesla/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as CompleteResponse;
      if (!response.ok) {
        throw new Error(data.error || "Failed to connect Tesla");
      }
      return data;
    },
    onMutate: () => setError(null),
    onSuccess: (data) => {
      if (data.success && data.systemId) {
        onConnected(data.systemId);
      } else if (data.needsSelection && data.selectionToken && data.vehicles) {
        setVehicles(data.vehicles);
        setSelectionToken(data.selectionToken);
        setStep("selecting");
      } else {
        setError("Unexpected response from Tesla connect.");
      }
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Failed to connect Tesla"),
  });

  const busy =
    disabled || connectMutation.isPending || completeMutation.isPending;

  return (
    <div className="space-y-4 mt-2">
      {step === "idle" && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">
            Connect your Tesla to monitor battery level and charging.
            You&apos;ll log in on Tesla&apos;s own page — we never see your
            password.
          </p>
          <ol className="text-sm text-gray-400 space-y-1 list-decimal list-inside">
            <li>Click Connect — Tesla&apos;s login opens in a new tab.</li>
            <li>Sign in (and approve MFA if prompted).</li>
            <li>
              You&apos;ll land on a blank <em>Page Not Found</em>. Copy that
              page&apos;s full web address.
            </li>
            <li>Come back here and paste it below.</li>
          </ol>
          <Button
            onClick={() => connectMutation.mutate()}
            disabled={busy}
            className="w-full"
          >
            {connectMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Opening Tesla…
              </>
            ) : (
              <>
                <ExternalLink className="mr-2 h-4 w-4" />
                Connect with Tesla
              </>
            )}
          </Button>
        </div>
      )}

      {step === "awaiting-paste" && (
        <div className="space-y-3">
          <Label htmlFor="tesla-callback-url" className="block mb-[10px]">
            Paste the Tesla page address
            <span className="text-red-500 ml-1">*</span>
          </Label>
          <textarea
            id="tesla-callback-url"
            value={pastedUrl}
            onChange={(e) => {
              setPastedUrl(e.target.value);
              setError(null);
            }}
            disabled={busy}
            rows={3}
            placeholder="https://auth.tesla.com/void/callback?code=…"
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 break-all"
          />
          <p className="text-xs text-gray-500">
            After logging in you&apos;ll see a &quot;Page Not Found&quot; —
            that&apos;s expected. Copy its full address from the browser bar and
            paste it here.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setStep("idle");
                setPastedUrl("");
                setError(null);
              }}
              disabled={busy}
              className="flex-1"
            >
              Back
            </Button>
            <Button
              onClick={() =>
                completeMutation.mutate({ callbackUrl: pastedUrl.trim() })
              }
              disabled={busy || !pastedUrl.trim()}
              className="flex-1 bg-green-600 hover:bg-green-700"
            >
              {completeMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connecting…
                </>
              ) : (
                "Add Vehicle"
              )}
            </Button>
          </div>
        </div>
      )}

      {step === "selecting" && (
        <div className="space-y-3">
          <p className="text-sm text-gray-300 font-medium">
            Choose a vehicle to add
          </p>
          <div className="space-y-2">
            {vehicles.map((v) => (
              <button
                key={v.id}
                onClick={() =>
                  selectionToken &&
                  completeMutation.mutate({
                    selectionToken,
                    vehicleId: v.id,
                  })
                }
                disabled={busy}
                className="w-full flex items-center gap-3 rounded-lg border border-gray-700 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 p-3 text-left transition-colors"
              >
                <Car className="h-5 w-5 text-gray-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-white text-sm font-medium truncate">
                    {v.displayName || "Tesla Vehicle"}
                  </div>
                  <div className="text-xs text-gray-500 truncate">{v.vin}</div>
                </div>
              </button>
            ))}
          </div>
          {completeMutation.isPending && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Adding vehicle…
            </div>
          )}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
