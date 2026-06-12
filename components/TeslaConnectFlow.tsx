"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";

interface TeslaConnectFlowProps {
  /**
   * Retained for API compatibility with AddSystemDialog. Not called in the redirect
   * flow — Tesla redirects back to /api/auth/tesla/callback, which creates the system
   * and forwards to /auth/tesla/result.
   */
  onConnected?: (systemId: number) => void;
  /** Whether the surrounding dialog is busy (disables actions). */
  disabled?: boolean;
}

/**
 * In-dialog Tesla Fleet API onboarding (standard OAuth redirect).
 *
 * Clicking Connect navigates to Tesla's login; after approval Tesla redirects back to
 * our `/api/auth/tesla/callback`, which exchanges the code, creates the system, and
 * forwards to `/auth/tesla/result`. (The legacy Owner API paste-back flow was removed —
 * its `void/callback` redirect is de-registered.)
 */
export default function TeslaConnectFlow({ disabled }: TeslaConnectFlowProps) {
  const [error, setError] = useState<string | null>(null);

  const connectMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/auth/tesla/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok || !data.authUrl) {
        throw new Error(data.error || "Failed to start Tesla login");
      }
      // Standard OAuth round-trip: navigate this tab to Tesla.
      window.location.href = data.authUrl as string;
    },
    onMutate: () => setError(null),
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Failed to start Tesla login",
      ),
  });

  const busy = disabled || connectMutation.isPending;

  return (
    <div className="space-y-4 mt-2">
      <p className="text-sm text-gray-400">
        Connect your Tesla to monitor battery level and charging, and control
        charging. You&apos;ll log in on Tesla&apos;s own page — we never see
        your password.
      </p>
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

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
