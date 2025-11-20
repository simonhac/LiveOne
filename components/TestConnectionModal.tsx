"use client";

import { useState, useEffect, useRef } from "react";
import { useModalContext } from "@/contexts/ModalContext";
import {
  CheckCircle,
  XCircle,
  Loader2,
  X,
  Zap,
  Sun,
  Home,
  Battery,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { formatValue, formatValuePair } from "@/lib/energy-formatting";
import { formatDateTime } from "@/lib/fe-date-format";
import JsonViewer from "@/components/JsonViewer";

// Helper to format value with unit as JSX with proper styling
const formatPowerJSX = (
  value: number | null | undefined,
  unit: string,
): React.JSX.Element => {
  const formatted = formatValue(value, unit);
  if (!formatted.unit) {
    return <span className="energy-value">{formatted.value}</span>;
  }
  return (
    <>
      <span className="energy-value">{formatted.value}</span>
      <span className="energy-unit">{formatted.unit}</span>
    </>
  );
};

// Helper to format value pair with unit as JSX with proper styling
const formatPairJSX = (
  inValue: number | null | undefined,
  outValue: number | null | undefined,
  unit: string,
): React.JSX.Element => {
  const formatted = formatValuePair(inValue, outValue, unit);
  if (!formatted.unit) {
    return <span className="energy-value">{formatted.value}</span>;
  }
  return (
    <>
      <span className="energy-value">{formatted.value}</span>
      <span className="energy-unit">{formatted.unit}</span>
    </>
  );
};

interface TestConnectionModalProps {
  // For existing systems (from dashboard or admin)
  systemId?: number;
  displayName?: string | null;
  vendorType?: string | null;

  // For new systems (from add system dialog) - not implemented yet
  // credentials would be passed another way

  onClose: () => void;
}

export default function TestConnectionModal({
  systemId,
  displayName,
  vendorType,
  onClose,
}: TestConnectionModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [vendorResponse, setVendorResponse] = useState<any>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasInitiatedTest = useRef(false);

  // Register this modal with the global modal context
  const { registerModal, unregisterModal } = useModalContext();
  useEffect(() => {
    registerModal("test-connection-modal");
    return () => unregisterModal("test-connection-modal");
  }, [registerModal, unregisterModal]);

  // Handle Escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const testConnection = async (isRefresh: boolean = false) => {
    if (isRefresh) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
      setData(null);
    }
    setError(null);

    if (!systemId) {
      setError("No system ID provided");
      return;
    }

    console.log("[TestConnectionModal] Testing connection for system:", {
      id: systemId,
      displayName: displayName,
    });

    try {
      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemId: systemId,
        }),
      });

      console.log("[TestConnectionModal] Response status:", response.status);

      const result = await response.json();
      console.log("[TestConnectionModal] Response data:", result);

      if (!response.ok) {
        // Log as info instead of error for expected failures
        console.log("[TestConnectionModal] Test failed:", result.error);
        throw new Error(result.error || "Connection test failed");
      }

      if (result.success && result.latest) {
        // Log raw response to browser console for debugging
        console.log("[TestConnectionModal] Success! Raw response:", result);

        // Store vendor's raw response for details panel
        setVendorResponse(result.vendorResponse);

        setData({
          latest: result.latest,
          systemInfo: result.systemInfo,
        });
        setError(null);
      } else {
        console.log("[TestConnectionModal] No data received. Result:", result);
        throw new Error(result.error || "No data received");
      }
    } catch (err) {
      console.log(
        "[TestConnectionModal] Test connection issue:",
        err instanceof Error ? err.message : "Connection test failed",
      );
      setError(err instanceof Error ? err.message : "Connection test failed");
      if (!isRefresh) {
        setData(null);
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  const refreshTest = () => {
    testConnection(true);
  };

  // Test connection when modal opens - but only once
  useEffect(() => {
    // Use ref to ensure test only happens once, even in StrictMode
    if (!hasInitiatedTest.current) {
      hasInitiatedTest.current = true;
      testConnection(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array means this runs once on mount

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-white">
            {displayName || "System"}{" "}
            {systemId ? (
              <span className="text-gray-500">ID: {systemId}</span>
            ) : (
              ""
            )}{" "}
            — {vendorType || "Test Connection"}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-900/20 border border-red-700 rounded-lg p-4 mb-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-400" />
              <p className="text-red-400">{error}</p>
            </div>
          </div>
        )}

        {/* Loading State - Initial */}
        {loading && !data && (
          <div className="text-center py-8">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-gray-400">Testing connection...</p>
          </div>
        )}

        {/* Data Display */}
        {data?.latest && (
          <div className="relative">
            {/* Refreshing Overlay */}
            {isRefreshing && (
              <div className="absolute inset-0 flex items-center justify-center z-10">
                <div className="bg-gray-800/90 rounded-lg p-4 flex items-center gap-3">
                  <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-gray-300">Refreshing...</span>
                </div>
              </div>
            )}

            <div
              className={`space-y-4 transition-opacity ${isRefreshing ? "opacity-40" : ""}`}
            >
              {/* Power Flow Section */}
              <div className="bg-gray-900 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-400 mb-3">
                  Current Power Flow
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="flex items-start gap-2">
                    <Sun className="w-5 h-5 text-yellow-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-400">Solar</p>
                      <p className="text-lg font-semibold text-yellow-400">
                        {formatPowerJSX(data.latest.solarW, "W")}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    <Home className="w-5 h-5 text-blue-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-400">Load</p>
                      <p className="text-lg font-semibold text-blue-400">
                        {formatPowerJSX(data.latest.loadW, "W")}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    <Battery className="w-5 h-5 text-green-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-400">Battery</p>
                      <p className="text-lg font-semibold text-green-400">
                        {data.latest.batterySOC !== null &&
                        data.latest.batterySOC !== undefined
                          ? `${data.latest.batterySOC.toFixed(1)}%`
                          : "—"}
                      </p>
                      <p className="text-xs text-gray-400">
                        {data.latest.batteryW !== null ? (
                          data.latest.batteryW < 0 ? (
                            <>
                              <span>Charging </span>
                              {formatPowerJSX(
                                Math.abs(data.latest.batteryW),
                                "W",
                              )}
                            </>
                          ) : data.latest.batteryW > 0 ? (
                            <>
                              <span>Discharging </span>
                              {formatPowerJSX(data.latest.batteryW, "W")}
                            </>
                          ) : (
                            "Idle"
                          )
                        ) : (
                          "No data"
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    <Zap className="w-5 h-5 text-purple-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-400">Grid</p>
                      <p className="text-lg font-semibold text-purple-400">
                        {formatPowerJSX(
                          data.latest.gridW !== null
                            ? Math.abs(data.latest.gridW)
                            : null,
                          "W",
                        )}
                      </p>
                      <p className="text-xs text-gray-400">
                        {data.latest.gridW !== null
                          ? data.latest.gridW > 0
                            ? "Importing"
                            : data.latest.gridW < 0
                              ? "Exporting"
                              : "No flow"
                          : "No data"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Lifetime Energy Section */}
              <div className="bg-gray-900 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-400 mb-3">
                  Lifetime Energy
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-gray-400">Solar Generated</p>
                    <p className="text-lg font-semibold text-white">
                      {formatPowerJSX(data.latest.solarKwhTotal, "kWh")}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Load Consumed</p>
                    <p className="text-lg font-semibold text-white">
                      {formatPowerJSX(data.latest.loadKwhTotal, "kWh")}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Battery In/Out</p>
                    <p className="text-lg font-semibold text-white">
                      {formatPairJSX(
                        data.latest.batteryInKwhTotal,
                        data.latest.batteryOutKwhTotal,
                        "kWh",
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Grid Import/Export</p>
                    <p className="text-lg font-semibold text-white">
                      {formatPairJSX(
                        data.latest.gridInKwhTotal,
                        data.latest.gridOutKwhTotal,
                        "kWh",
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {/* System Info Section */}
              {data.systemInfo && (
                <div className="bg-gray-900 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-gray-400 mb-3">
                    System Information
                  </h4>
                  <div className="grid grid-cols-4 gap-4">
                    {data.systemInfo.model && (
                      <div>
                        <p className="text-xs text-gray-400">Model</p>
                        <p className="text-sm text-white">
                          {data.systemInfo.model}
                        </p>
                      </div>
                    )}
                    {data.systemInfo.serial && (
                      <div>
                        <p className="text-xs text-gray-400">Serial</p>
                        <p className="text-sm text-white">
                          {data.systemInfo.serial}
                        </p>
                      </div>
                    )}
                    {data.systemInfo.solarSize && (
                      <div>
                        <p className="text-xs text-gray-400">Solar Size</p>
                        <p className="text-sm text-white">
                          {data.systemInfo.solarSize}
                        </p>
                      </div>
                    )}
                    {data.systemInfo.batterySize && (
                      <div>
                        <p className="text-xs text-gray-400">Battery Size</p>
                        <p className="text-sm text-white">
                          {data.systemInfo.batterySize}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Raw Comms Disclosure */}
              {vendorResponse && (
                <div className="mt-4">
                  <JsonViewer data={vendorResponse} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6 flex gap-3">
          {data && (
            <button
              onClick={refreshTest}
              disabled={isRefreshing}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg transition-colors"
            >
              <RefreshCw
                className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          )}

          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
