"use client";

import { useState, useRef, useEffect } from "react";
import { UserButton } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronDown,
  Settings as SettingsIcon,
  Shield,
  FlaskConical,
  Plus,
  Database,
  RefreshCw,
  Menu,
  X,
} from "lucide-react";
import LastUpdateTime from "@/components/LastUpdateTime";
import SystemInfoTooltip from "@/components/SystemInfoTooltip";
import MobileHeaderMenu from "@/components/MobileHeaderMenu";
import SystemsMenu from "@/components/SystemsMenu";

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

export interface DashboardHeaderProps {
  // Display properties
  displayName: string;
  systemId?: string;
  vendorSiteId?: string;

  // Time and status
  lastUpdate: Date | null;

  // System information
  systemInfo?: SystemInfo | null;
  vendorType?: string;
  supportsPolling?: boolean;
  systemStatus?: "active" | "disabled" | "removed";

  // User and access
  isAdmin: boolean;
  userId?: string;

  // Available systems for switching
  availableSystems?: AvailableSystem[];

  // Callbacks
  onLogout: () => void;
  onTestConnection?: () => void;
  onViewData?: () => void;
  onPollNow?: (dryRun?: boolean) => void;
  onAddSystem?: () => void;
  onSystemSettings?: () => void;

  // Shift key state (for dry run)
  shiftKeyDown?: boolean;
}

export default function DashboardHeader({
  displayName,
  systemId,
  vendorSiteId,
  lastUpdate,
  systemInfo,
  vendorType,
  supportsPolling = false,
  systemStatus,
  isAdmin,
  userId,
  availableSystems = [],
  onLogout,
  onTestConnection,
  onViewData,
  onPollNow,
  onAddSystem,
  onSystemSettings,
  shiftKeyDown = false,
}: DashboardHeaderProps) {
  const router = useRouter();
  const [showSystemDropdown, setShowSystemDropdown] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileSystemDropdownOpen, setIsMobileSystemDropdownOpen] =
    useState(false);
  const [longPressActive, setLongPressActive] = useState(false);
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const settingsDropdownRef = useRef<HTMLDivElement>(null);
  const mobileSystemDropdownRef = useRef<HTMLDivElement>(null);

  const isDryRunMode = shiftKeyDown || longPressActive;

  // Long-press handlers for mobile hamburger menu button
  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => {
      setLongPressActive(true);
    }, 500); // 500ms long-press threshold
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleTouchCancel = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    setLongPressActive(false);
  };

  // Handle system selection in mobile dropdown
  const handleMobileSystemSelect = (systemId: number) => {
    const system = availableSystems.find((s) => s.id === systemId);
    const path =
      system?.ownerUsername && system?.alias
        ? `/dashboard/${system.ownerUsername}/${system.alias}`
        : `/dashboard/${systemId}`;
    router.push(path);
    setIsMobileSystemDropdownOpen(false);
  };

  // Reset long-press when menu closes
  useEffect(() => {
    if (!isMobileMenuOpen) {
      setLongPressActive(false);
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    }
  }, [isMobileMenuOpen]);

  // Handle clicks outside of the dropdowns
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowSystemDropdown(false);
      }
      if (
        settingsDropdownRef.current &&
        !settingsDropdownRef.current.contains(event.target as Node)
      ) {
        setShowSettingsDropdown(false);
      }
      if (
        mobileSystemDropdownRef.current &&
        !mobileSystemDropdownRef.current.contains(event.target as Node)
      ) {
        setIsMobileSystemDropdownOpen(false);
      }
    };

    if (
      showSystemDropdown ||
      showSettingsDropdown ||
      isMobileSystemDropdownOpen
    ) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showSystemDropdown, showSettingsDropdown, isMobileSystemDropdownOpen]);

  return (
    <header className="bg-gray-800 border-b border-gray-700">
      <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8 py-2 sm:py-4">
        {/* Mobile Header Bar */}
        <div className="sm:hidden">
          <div className="flex justify-between items-center">
            <div className="relative" ref={mobileSystemDropdownRef}>
              {availableSystems.length > 1 ? (
                <button
                  onClick={() =>
                    setIsMobileSystemDropdownOpen(!isMobileSystemDropdownOpen)
                  }
                  className="flex items-center gap-1 text-base font-bold text-white hover:text-blue-400 transition-colors"
                >
                  {displayName || "Select System"}
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${isMobileSystemDropdownOpen ? "rotate-180" : ""}`}
                  />
                </button>
              ) : (
                <h1 className="text-base font-bold text-white">
                  {displayName || "LiveOne"}
                </h1>
              )}

              {/* System Dropdown Menu */}
              {isMobileSystemDropdownOpen && availableSystems.length > 1 && (
                <div className="absolute top-full left-0 mt-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
                  <SystemsMenu
                    availableSystems={availableSystems}
                    currentSystemId={systemId}
                    userId={userId}
                    isAdmin={isAdmin}
                    onSystemSelect={(systemId) => {
                      handleMobileSystemSelect(systemId);
                      setIsMobileSystemDropdownOpen(false);
                    }}
                    isMobile={true}
                    itemClassName="w-full text-left px-4 py-2 text-sm hover:bg-gray-700 transition-colors first:rounded-t-lg last:rounded-b-lg text-white"
                    activeItemClassName="text-blue-400 bg-gray-700/50"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Connection Status and Time */}
              <LastUpdateTime
                lastUpdate={lastUpdate}
                showIcon={true}
                className="text-xs"
              />

              {/* Admin Link */}
              {isAdmin && (
                <Link
                  href="/admin/systems"
                  className="p-1.5 text-blue-500 hover:text-blue-400 transition-colors"
                  aria-label="Admin"
                >
                  <Shield className="w-4 h-4" />
                </Link>
              )}

              {/* Hamburger Menu Button */}
              <button
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchCancel}
                className="p-1.5 text-gray-400 hover:text-white transition-colors"
                aria-label="Toggle menu"
              >
                {isMobileMenuOpen ? (
                  <X className="w-4 h-4" />
                ) : (
                  <Menu className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Menu Overlay */}
        <MobileHeaderMenu
          isOpen={isMobileMenuOpen}
          onClose={() => setIsMobileMenuOpen(false)}
          onLogout={onLogout}
          systemInfo={systemInfo}
          vendorType={vendorType}
          supportsPolling={supportsPolling}
          isAdmin={isAdmin}
          systemStatus={systemStatus}
          onTestConnection={onTestConnection}
          onViewData={onViewData}
          onPollNow={onPollNow}
          onAddSystem={onAddSystem}
          onSystemSettings={onSystemSettings}
          isDryRunMode={isDryRunMode}
        />

        {/* Desktop Layout */}
        <div className="hidden sm:flex justify-between items-center">
          <div className="relative" ref={dropdownRef}>
            {availableSystems.length > 1 ? (
              <>
                <button
                  onClick={() => setShowSystemDropdown(!showSystemDropdown)}
                  className="flex items-center gap-2 hover:bg-gray-700 rounded-lg px-3 py-2 transition-colors"
                >
                  <h1 className="text-2xl font-bold text-white">
                    {displayName}
                  </h1>
                  <ChevronDown
                    className={`w-5 h-5 text-gray-400 transition-transform ${showSystemDropdown ? "rotate-180" : ""}`}
                  />
                </button>

                {showSystemDropdown && (
                  <div className="absolute top-full left-0 mt-2 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
                    <div className="py-1">
                      <SystemsMenu
                        availableSystems={availableSystems}
                        currentSystemId={systemId}
                        userId={userId}
                        isAdmin={isAdmin}
                        onSystemSelect={() => setShowSystemDropdown(false)}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <h1 className="text-2xl font-bold text-white">{displayName}</h1>
            )}
          </div>
          <div className="flex items-center gap-4">
            <LastUpdateTime lastUpdate={lastUpdate} />
            {systemInfo && (
              <SystemInfoTooltip
                systemInfo={systemInfo}
                systemNumber={vendorSiteId || ""}
              />
            )}
            {isAdmin && (
              <Link
                href="/admin/systems"
                className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm font-medium"
              >
                <Shield className="w-4 h-4" />
                Admin
              </Link>
            )}
            {/* Settings dropdown - Only show for admin or non-removed systems */}
            {(isAdmin || systemStatus !== "removed") && (
              <div className="relative" ref={settingsDropdownRef}>
                <button
                  onClick={() => setShowSettingsDropdown(!showSettingsDropdown)}
                  className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                  title="Settings"
                >
                  <SettingsIcon className="w-5 h-5" />
                </button>

                {showSettingsDropdown && (
                  <div className="absolute right-0 mt-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
                    {/* View Data - Show for admin users, disabled for composite systems */}
                    {isAdmin && onViewData && (
                      <>
                        <button
                          onClick={() => {
                            if (vendorType !== "composite") {
                              onViewData();
                              setShowSettingsDropdown(false);
                            }
                          }}
                          disabled={vendorType === "composite"}
                          className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
                            vendorType !== "composite"
                              ? "text-gray-300 hover:bg-gray-700 hover:text-white transition-colors cursor-pointer"
                              : "text-gray-500 cursor-not-allowed opacity-70"
                          }`}
                        >
                          <Database className="w-4 h-4" />
                          View Data…
                        </button>
                        {/* Poll Now - Always show, disabled for systems that don't support polling */}
                        {onPollNow && (
                          <button
                            onClick={() => {
                              if (supportsPolling) {
                                onPollNow(shiftKeyDown);
                                setShowSettingsDropdown(false);
                              }
                            }}
                            disabled={!supportsPolling}
                            className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
                              supportsPolling
                                ? "text-gray-300 hover:bg-gray-700 hover:text-white transition-colors cursor-pointer"
                                : "text-gray-500 cursor-not-allowed opacity-70"
                            }`}
                          >
                            <RefreshCw className="w-4 h-4" />
                            {shiftKeyDown ? "Dry Run Poll…" : "Poll Now…"}
                          </button>
                        )}
                        <div className="border-t border-gray-700 my-1"></div>
                      </>
                    )}

                    {/* Test Connection - Only show for vendors that support polling */}
                    {supportsPolling && onTestConnection && (
                      <button
                        onClick={() => {
                          onTestConnection();
                          setShowSettingsDropdown(false);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
                      >
                        <FlaskConical className="w-4 h-4" />
                        Test Connection…
                      </button>
                    )}

                    {/* Always show Add System */}
                    {onAddSystem && (
                      <button
                        onClick={() => {
                          setShowSettingsDropdown(false);
                          onAddSystem();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
                      >
                        <Plus className="w-4 h-4" />
                        Add System…
                      </button>
                    )}

                    {/* System Settings */}
                    {onSystemSettings && (
                      <button
                        onClick={() => {
                          setShowSettingsDropdown(false);
                          onSystemSettings();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
                      >
                        <SettingsIcon className="w-4 h-4" />
                        System Settings…
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <UserButton
              afterSignOutUrl="/sign-in"
              appearance={{
                elements: {
                  avatarBox: "w-8 h-8",
                },
              }}
            />
          </div>
        </div>
      </div>
    </header>
  );
}
