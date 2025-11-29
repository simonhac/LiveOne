"use client";

import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { CheckCircle, XCircle, AlertTriangle, Car } from "lucide-react";
import { Suspense } from "react";

function TeslaResultContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const status = searchParams.get("status");
  const message = searchParams.get("message");
  const error = searchParams.get("error");

  // Determine the display based on params
  const isSuccess = status === "success";
  const isError = status === "error" || error !== null;

  // Determine what to show
  let icon;
  let title;
  let description;
  let iconColor;

  if (isSuccess) {
    icon = <CheckCircle className="h-16 w-16" />;
    iconColor = "text-green-500";
    title = "Successfully Connected!";
    description =
      message || "Your Tesla vehicle has been connected successfully.";
  } else if (error === "access_denied") {
    icon = <XCircle className="h-16 w-16" />;
    iconColor = "text-yellow-500";
    title = "Connection Cancelled";
    description =
      "You cancelled the Tesla authorization. You can try again anytime.";
  } else if (error === "state_expired") {
    icon = <AlertTriangle className="h-16 w-16" />;
    iconColor = "text-orange-500";
    title = "Session Expired";
    description =
      "Your authorization session expired. Please try connecting again.";
  } else if (error === "no_vehicles") {
    icon = <Car className="h-16 w-16" />;
    iconColor = "text-yellow-500";
    title = "No Vehicles Found";
    description =
      "No Tesla vehicles were found for your account. Please check your Tesla account.";
  } else if (error === "invalid_state" || error === "invalid_callback") {
    icon = <AlertTriangle className="h-16 w-16" />;
    iconColor = "text-orange-500";
    title = "Invalid Request";
    description =
      "The authorization request was invalid. Please try connecting again.";
  } else if (isError) {
    icon = <XCircle className="h-16 w-16" />;
    iconColor = "text-red-500";
    title = "Connection Failed";
    description =
      message || "Failed to connect to your Tesla vehicle. Please try again.";
  } else {
    // Invalid state, redirect immediately
    router.push("/dashboard");
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8 text-center">
        <div className="bg-gray-800 rounded-lg p-8 shadow-xl">
          {/* Icon */}
          <div
            className={`mx-auto flex items-center justify-center ${iconColor} mb-6`}
          >
            {icon}
          </div>

          {/* Title */}
          <h1 className="text-2xl font-bold text-white mb-4">{title}</h1>

          {/* Description */}
          <p className="text-gray-300 mb-8">{description}</p>

          {/* Actions */}
          <div className="space-y-4">
            <button
              onClick={() => router.push("/dashboard")}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Go to Dashboard
            </button>

            {isError && error !== "access_denied" && (
              <button
                onClick={async () => {
                  try {
                    const response = await fetch("/api/auth/tesla/connect", {
                      method: "POST",
                    });

                    if (!response.ok) {
                      throw new Error("Failed to initiate Tesla connection");
                    }

                    const data = await response.json();
                    if (data.authUrl) {
                      window.location.href = data.authUrl;
                    }
                  } catch (err) {
                    console.error("Failed to restart Tesla connection:", err);
                  }
                }}
                className="w-full px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TeslaResultPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
          <div className="text-white">Loading...</div>
        </div>
      }
    >
      <TeslaResultContent />
    </Suspense>
  );
}
