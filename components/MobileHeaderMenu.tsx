"use client";

import { useUser } from "@clerk/nextjs";
import {
  X,
  User,
  LogOut,
  Info,
  Settings,
  FlaskConical,
  Plus,
  Database,
  RefreshCw,
} from "lucide-react";

interface SystemInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface MobileHeaderMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onLogout: () => void;
  systemInfo?: SystemInfo | null;
  vendorType?: string;
  supportsPolling?: boolean;
  isAdmin?: boolean;
  systemStatus?: "active" | "disabled" | "removed";
  onTestConnection?: () => void;
  onViewData?: () => void;
  onPollNow?: (dryRun?: boolean) => void;
  onAddSystem?: () => void;
  onSystemSettings?: () => void;
  isDryRunMode?: boolean;
}

export default function MobileHeaderMenu({
  isOpen,
  onClose,
  onLogout,
  systemInfo,
  vendorType,
  supportsPolling = false,
  isAdmin = false,
  systemStatus,
  onTestConnection,
  onViewData,
  onPollNow,
  onAddSystem,
  onSystemSettings,
  isDryRunMode = false,
}: MobileHeaderMenuProps) {
  const { user } = useUser();

  if (!isOpen) return null;

  return (
    <>
      {/* Mobile Menu Overlay */}
      {isOpen && (
        <div className="sm:hidden fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Menu Panel */}
          <div className="absolute right-0 top-0 h-full w-64 bg-gray-800 shadow-xl">
            {/* Menu Header */}
            <div className="flex justify-between items-center p-4 border-b border-gray-700">
              <h2 className="text-lg font-semibold text-white">Menu</h2>
              <button
                onClick={onClose}
                className="p-1 text-gray-400 hover:text-white transition-colors"
                aria-label="Close menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Menu Content */}
            <div className="p-4 space-y-4">
              {/* User Section */}
              <div className="flex items-center gap-3 p-3 bg-gray-700/50 rounded">
                <User className="w-5 h-5 text-gray-400" />
                <div>
                  <p className="text-sm text-gray-400">Logged in as</p>
                  <p className="text-white font-medium">
                    {user?.firstName && user?.lastName
                      ? `${user.firstName} ${user.lastName}`
                      : user?.username ||
                        user?.primaryEmailAddress?.emailAddress ||
                        "User"}
                  </p>
                </div>
              </div>

              {/* Settings Section */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 mb-2">
                  <Settings className="w-4 h-4 text-gray-400" />
                  <p className="text-white font-medium text-sm">Settings</p>
                </div>

                {/* View Data - Show for admin users, disabled for composite systems */}
                {onViewData && isAdmin && (
                  <button
                    onClick={() => {
                      if (vendorType !== "composite") {
                        onClose();
                        onViewData();
                      }
                    }}
                    disabled={vendorType === "composite"}
                    className={`w-full p-3 rounded text-left text-sm flex items-center gap-2 ${
                      vendorType !== "composite"
                        ? "bg-gray-700/50 hover:bg-gray-700 text-white transition-colors cursor-pointer"
                        : "bg-gray-800/50 text-gray-500 cursor-not-allowed opacity-70"
                    }`}
                  >
                    <Database className="w-4 h-4" />
                    View Data…
                  </button>
                )}

                {/* Poll Now - Show for admin users, disabled for systems that don't support polling */}
                {onPollNow && isAdmin && (
                  <button
                    onClick={() => {
                      if (supportsPolling) {
                        onClose();
                        onPollNow(isDryRunMode);
                      }
                    }}
                    disabled={!supportsPolling}
                    className={`w-full p-3 rounded text-left text-sm flex items-center gap-2 ${
                      supportsPolling
                        ? "bg-gray-700/50 hover:bg-gray-700 text-white transition-colors cursor-pointer"
                        : "bg-gray-800/50 text-gray-500 cursor-not-allowed opacity-70"
                    }`}
                  >
                    <RefreshCw className="w-4 h-4" />
                    {isDryRunMode ? "Dry Run Poll…" : "Poll Now…"}
                  </button>
                )}

                {/* Test Connection - Only show for vendors that support polling and for admin or non-removed systems */}
                {onTestConnection &&
                  supportsPolling &&
                  (isAdmin || systemStatus !== "removed") && (
                    <button
                      onClick={() => {
                        onClose();
                        onTestConnection();
                      }}
                      className="w-full p-3 bg-gray-700/50 hover:bg-gray-700 rounded text-left text-sm text-white transition-colors flex items-center gap-2"
                    >
                      <FlaskConical className="w-4 h-4" />
                      Test Connection…
                    </button>
                  )}

                {/* Add System */}
                {onAddSystem && (
                  <button
                    onClick={() => {
                      onClose();
                      onAddSystem();
                    }}
                    className="w-full p-3 bg-gray-700/50 hover:bg-gray-700 rounded text-left text-sm text-white transition-colors flex items-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    Add System…
                  </button>
                )}

                {/* System Settings */}
                {onSystemSettings && (
                  <button
                    onClick={() => {
                      onClose();
                      onSystemSettings();
                    }}
                    className="w-full p-3 bg-gray-700/50 hover:bg-gray-700 rounded text-left text-sm text-white transition-colors flex items-center gap-2"
                  >
                    <Settings className="w-4 h-4" />
                    System Settings…
                  </button>
                )}
              </div>

              {/* System Info Section */}
              {systemInfo && (
                <div className="p-3 bg-gray-700/50 rounded space-y-2">
                  <div className="flex items-center gap-2 mb-2">
                    <Info className="w-4 h-4 text-gray-400" />
                    <p className="text-white font-medium text-sm">
                      System Information
                    </p>
                  </div>
                  <div className="space-y-1 text-xs">
                    {systemInfo.model && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Model:</span>
                        <span className="text-white">{systemInfo.model}</span>
                      </div>
                    )}
                    {systemInfo.serial && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Serial:</span>
                        <span className="text-white">{systemInfo.serial}</span>
                      </div>
                    )}
                    {systemInfo.ratings && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Ratings:</span>
                        <span className="text-white">{systemInfo.ratings}</span>
                      </div>
                    )}
                    {systemInfo.solarSize && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Solar:</span>
                        <span className="text-white">
                          {systemInfo.solarSize}
                        </span>
                      </div>
                    )}
                    {systemInfo.batterySize && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Battery:</span>
                        <span className="text-white">
                          {systemInfo.batterySize}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Logout Button */}
              <button
                onClick={() => {
                  onClose();
                  onLogout();
                }}
                className="w-full bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded flex items-center justify-center gap-2 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
