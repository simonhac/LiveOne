"use client";

import { useState, useEffect, ReactNode } from "react";
import { useRouter } from "next/navigation";
import DashboardHeader from "@/components/DashboardHeader";
import TestConnectionModal from "@/components/TestConnectionModal";
import PollNowModal from "@/components/PollNowModal";
import ServerErrorModal from "@/components/ServerErrorModal";
import SessionTimeoutModal from "@/components/SessionTimeoutModal";
import { AddSystemDialog } from "@/components/AddSystemDialog";
import ViewDataModal from "@/components/ViewDataModal";
import SystemSettingsDialog from "@/components/SystemSettingsDialog";
import ConnectionNotification from "@/components/ConnectionNotification";

interface SystemInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface System {
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

interface DashboardLayoutProps {
  system: System;
  userId: string;
  isAdmin: boolean;
  availableSystems: AvailableSystem[];
  lastUpdate?: Date | null;
  systemInfo?: SystemInfo | null;
  supportsPolling?: boolean;
  children: ReactNode;
  onSystemUpdate?: (updates?: {
    displayName?: string;
    alias?: string | null;
  }) => void;
}

export default function DashboardLayout({
  system,
  userId,
  isAdmin,
  availableSystems,
  lastUpdate,
  systemInfo,
  supportsPolling,
  children,
  onSystemUpdate,
}: DashboardLayoutProps) {
  const router = useRouter();
  const [showTestConnection, setShowTestConnection] = useState(false);
  const [showPollNow, setShowPollNow] = useState<{
    isOpen: boolean;
    dryRun: boolean;
  }>({ isOpen: false, dryRun: false });
  const [showAddSystemDialog, setShowAddSystemDialog] = useState(false);
  const [showSystemSettingsDialog, setShowSystemSettingsDialog] =
    useState(false);
  const [serverError, setServerError] = useState<{
    type: "connection" | "server" | null;
    details?: string;
  }>({ type: null });
  const [showSessionTimeout, setShowSessionTimeout] = useState(false);
  const [showViewDataModal, setShowViewDataModal] = useState(false);
  const [shiftKeyDown, setShiftKeyDown] = useState(false);

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

  const handleUpdateSystemSettings = async (updates?: {
    displayName?: string;
    alias?: string | null;
  }) => {
    if (onSystemUpdate) {
      await onSystemUpdate(updates);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Connection Notification */}
      <ConnectionNotification />

      {/* Header */}
      <DashboardHeader
        displayName={system.displayName}
        systemId={system.id.toString()}
        vendorSiteId={system.vendorSiteId}
        lastUpdate={lastUpdate ?? null}
        systemInfo={systemInfo ?? null}
        vendorType={system.vendorType}
        supportsPolling={supportsPolling ?? system.supportsPolling ?? false}
        systemStatus={system.status as "active" | "disabled" | "removed"}
        isAdmin={isAdmin}
        userId={userId}
        availableSystems={availableSystems}
        onLogout={handleLogout}
        onTestConnection={() => setShowTestConnection(true)}
        onViewData={() => setShowViewDataModal(true)}
        onPollNow={(dryRun) =>
          setShowPollNow({ isOpen: true, dryRun: dryRun || false })
        }
        onAddSystem={() => setShowAddSystemDialog(true)}
        onSystemSettings={() => setShowSystemSettingsDialog(true)}
        shiftKeyDown={shiftKeyDown}
      />

      {/* Main Content */}
      {children}

      {/* Test Connection Modal */}
      {showTestConnection && (
        <TestConnectionModal
          systemId={system.id}
          displayName={system.displayName}
          vendorType={system.vendorType}
          onClose={() => setShowTestConnection(false)}
        />
      )}

      {/* Poll Now Modal */}
      {showPollNow.isOpen && (
        <PollNowModal
          systemId={system.id}
          displayName={system.displayName}
          vendorType={system.vendorType}
          dryRun={showPollNow.dryRun}
          onClose={() => setShowPollNow({ isOpen: false, dryRun: false })}
        />
      )}

      {/* Add System Dialog */}
      <AddSystemDialog
        open={showAddSystemDialog}
        onOpenChange={setShowAddSystemDialog}
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
          systemId={system.id}
          systemName={system.displayName}
          vendorType={system.vendorType}
          vendorSiteId={system.vendorSiteId}
          timezoneOffsetMin={system.timezoneOffsetMin}
        />
      )}

      {/* System Settings Dialog */}
      <SystemSettingsDialog
        isOpen={showSystemSettingsDialog}
        onClose={() => setShowSystemSettingsDialog(false)}
        systemId={system.id}
        vendorType={system.vendorType}
        metadata={system.metadata}
        ownerClerkUserId={system.ownerClerkUserId ?? undefined}
        isAdmin={isAdmin}
        onUpdate={handleUpdateSystemSettings}
      />
    </div>
  );
}
