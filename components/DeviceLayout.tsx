"use client";

import { useState, useEffect, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import DashboardHeader from "@/components/DashboardHeader";
import TestConnectionModal from "@/components/TestConnectionModal";
import UpdateCredentialsModal from "@/components/UpdateCredentialsModal";
import PollNowModal from "@/components/PollNowModal";
import ServerErrorModal from "@/components/ServerErrorModal";
import SessionTimeoutModal from "@/components/SessionTimeoutModal";
import { AddDeviceDialog } from "@/components/AddDeviceDialog";
import ViewDataModal from "@/components/ViewDataModal";
import DeviceSettingsDialog from "@/components/DeviceSettingsDialog";
import ConnectionNotification from "@/components/ConnectionNotification";
import { ChartFocusProvider } from "@/lib/charts/ChartFocusContext";

interface DeviceInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface AvailableDevice {
  id: number;
  displayName: string;
  vendorSiteId: string;
  vendorType: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface Device {
  id: number;
  vendorType: string;
  vendorSiteId: string;
  displayName: string;
  alias: string | null;
  displayTimezone: string | null;
  ownerClerkUserId: string | null;
  timezoneOffsetMin: number;
  status: string;
  model: string | null;
  serial: string | null;
  ratings: string | null;
  solarSize: string | null;
  batterySize: string | null;
  supportsPolling?: boolean;
  metadata: any;
}

interface DeviceLayoutProps {
  device: Device;
  userId: string;
  isAdmin: boolean;
  availableDevices: AvailableDevice[];
  lastUpdate?: Date | null;
  deviceInfo?: DeviceInfo | null;
  supportsPolling?: boolean;
  children: ReactNode;
  onDeviceUpdate?: (updates?: {
    displayName?: string;
    alias?: string | null;
  }) => void;
  /** Header temporal navigator config, computed server-side; null ⇒ no time-traveling component. */
  temporalNav?: { handle: number; timezoneOffsetMin: number } | null;
}

/**
 * Chrome for the read-only per-device viewer ("Device") at /device/{id}: the header (admin/util
 * tools + Device Settings) plus the device's admin modals. Recut from the former DashboardLayout —
 * NO DashboardCustomizeProvider, so the header's Customise/Share/Location items self-hide.
 */
export default function DeviceLayout({
  device,
  userId,
  isAdmin,
  availableDevices,
  lastUpdate,
  deviceInfo,
  supportsPolling,
  children,
  onDeviceUpdate,
  temporalNav,
}: DeviceLayoutProps) {
  const router = useRouter();
  const [showTestConnection, setShowTestConnection] = useState(false);
  const [showPollNow, setShowPollNow] = useState<{
    isOpen: boolean;
    dryRun: boolean;
  }>({ isOpen: false, dryRun: false });
  const [showAddDeviceDialog, setShowAddDeviceDialog] = useState(false);
  const [showDeviceSettingsDialog, setShowDeviceSettingsDialog] =
    useState(false);
  const [serverError, setServerError] = useState<{
    type: "connection" | "server" | null;
    details?: string;
  }>({ type: null });
  const [showSessionTimeout, setShowSessionTimeout] = useState(false);
  const [showViewDataModal, setShowViewDataModal] = useState(false);
  const [showUpdateCredentials, setShowUpdateCredentials] = useState(false);
  const [shiftKeyDown, setShiftKeyDown] = useState(false);

  // Credential rotation only applies to vendors with editable credential fields — not OAuth
  // vendors (Tesla, which re-auths via its own flow) or push/app-key vendors. Gate the menu
  // item on the vendor catalogue so it self-hides where it doesn't apply.
  const { data: vendorsData } = useQuery({
    queryKey: ["addSystem", "options"],
    queryFn: () =>
      fetchJson<{
        vendors: {
          vendorType: string;
          addDeviceFlow?: string;
          credentialFields: unknown[];
        }[];
      }>("/api/vendors"),
  });
  const canUpdateCredentials = !!vendorsData?.vendors.some(
    (v) =>
      v.vendorType === device.vendorType &&
      v.addDeviceFlow !== "oauth-redirect" &&
      (v.credentialFields?.length ?? 0) > 0,
  );

  // Shift key detection for dry run mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey) {
        setShiftKeyDown(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.shiftKey) {
        setShiftKeyDown(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const handleLogout = async () => {
    router.push("/sign-in");
  };

  const handleUpdateDeviceSettings = async (updates?: {
    displayName?: string;
    alias?: string | null;
  }) => {
    if (onDeviceUpdate) {
      await onDeviceUpdate(updates);
    }
    // Refresh server components to update devices list (e.g., if display name changed)
    router.refresh();
  };

  return (
    <ChartFocusProvider>
      <div className="min-h-screen bg-gray-900">
        {/* Connection Notification */}
        <ConnectionNotification />

        {/* Header */}
        <DashboardHeader
          temporalNav={temporalNav}
          displayName={device.displayName}
          systemId={device.id.toString()}
          vendorSiteId={device.vendorSiteId}
          lastUpdate={lastUpdate ?? null}
          deviceInfo={deviceInfo ?? null}
          vendorType={device.vendorType}
          supportsPolling={supportsPolling ?? device.supportsPolling ?? false}
          deviceStatus={device.status as "active" | "disabled" | "removed"}
          isAdmin={isAdmin}
          userId={userId}
          availableDevices={availableDevices}
          onLogout={handleLogout}
          onTestConnection={() => setShowTestConnection(true)}
          onViewData={() => setShowViewDataModal(true)}
          onPollNow={(dryRun) =>
            setShowPollNow({ isOpen: true, dryRun: dryRun || false })
          }
          onAddDevice={() => setShowAddDeviceDialog(true)}
          onDeviceSettings={() => setShowDeviceSettingsDialog(true)}
          onUpdateCredentials={
            canUpdateCredentials
              ? () => setShowUpdateCredentials(true)
              : undefined
          }
          shiftKeyDown={shiftKeyDown}
        />

        {/* Main Content */}
        {children}

        {/* Test Connection Modal */}
        {showTestConnection && (
          <TestConnectionModal
            systemId={device.id}
            displayName={device.displayName}
            vendorType={device.vendorType}
            onClose={() => setShowTestConnection(false)}
          />
        )}

        {/* Update Credentials Modal */}
        {showUpdateCredentials && (
          <UpdateCredentialsModal
            systemId={device.id}
            displayName={device.displayName}
            vendorType={device.vendorType}
            onClose={() => setShowUpdateCredentials(false)}
            onUpdated={() => router.refresh()}
          />
        )}

        {/* Poll Now Modal */}
        {showPollNow.isOpen && (
          <PollNowModal
            systemId={device.id}
            displayName={device.displayName}
            vendorType={device.vendorType}
            dryRun={showPollNow.dryRun}
            onClose={() => setShowPollNow({ isOpen: false, dryRun: false })}
          />
        )}

        {/* Add Device Dialog */}
        <AddDeviceDialog
          open={showAddDeviceDialog}
          onOpenChange={setShowAddDeviceDialog}
        />

        <ServerErrorModal
          isOpen={serverError.type !== null}
          onClose={() => setServerError({ type: null })}
          errorType={serverError.type}
          errorDetails={serverError.details}
        />

        <SessionTimeoutModal
          isOpen={showSessionTimeout}
          onReconnect={() => {
            setShowSessionTimeout(false);
            window.location.reload();
          }}
        />

        {/* View Data Modal */}
        {showViewDataModal && (
          <ViewDataModal
            isOpen={showViewDataModal}
            onClose={() => setShowViewDataModal(false)}
            systemId={device.id}
            deviceName={device.displayName}
            vendorType={device.vendorType}
            vendorSiteId={device.vendorSiteId}
            timezoneOffsetMin={device.timezoneOffsetMin}
          />
        )}

        {/* Device Settings Dialog */}
        <DeviceSettingsDialog
          isOpen={showDeviceSettingsDialog}
          onClose={() => setShowDeviceSettingsDialog(false)}
          systemId={device.id}
          vendorType={device.vendorType}
          metadata={device.metadata}
          ownerClerkUserId={device.ownerClerkUserId ?? undefined}
          isAdmin={isAdmin}
          onUpdate={handleUpdateDeviceSettings}
        />
      </div>
    </ChartFocusProvider>
  );
}
