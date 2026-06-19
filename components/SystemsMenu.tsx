"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Star, LayoutDashboard } from "lucide-react";
import { myDashboardsQuery, userPreferencesQuery } from "@/lib/queries";

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  vendorType: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface SystemsMenuProps {
  availableSystems: AvailableSystem[];
  currentSystemId?: string;
  userId?: string;
  isAdmin?: boolean;
  defaultSystemId?: number | null;
  onSystemSelect?: (systemId: number) => void;
  /** Close the parent dropdown after picking the "Go to Dashboards" cross-nav row. */
  onNavigate?: () => void;
  /** Only fetch the dashboards/default for the "Go to Dashboards" footer when this is a real owner. */
  enabled?: boolean;
  preserveQueryParams?: string[];
  className?: string;
  itemClassName?: string;
  activeItemClassName?: string;
  isMobile?: boolean;
}

export default function SystemsMenu({
  availableSystems,
  currentSystemId,
  userId,
  isAdmin = false,
  defaultSystemId,
  onSystemSelect,
  onNavigate,
  enabled = true,
  preserveQueryParams = ["period"],
  className = "",
  itemClassName = "block px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors",
  activeItemClassName = "bg-gray-700",
  isMobile = false,
}: SystemsMenuProps) {
  // "Go to Dashboards" cross-nav: jump to the user's default composition dashboard if set (and still
  // in the list), else the first one. Same queries the header prefetches (usePrefetchDashboardsMenu)
  // → deduped, no extra fetch. Hidden when the user has no composition dashboards.
  const { data: dashData } = useQuery(myDashboardsQuery(enabled));
  const { data: prefs } = useQuery(userPreferencesQuery(enabled));
  const dashboards = dashData?.dashboards ?? [];
  const defaultDashboardId = prefs?.preferences.defaultDashboardId ?? null;
  const goToDashboardId = dashboards.some((d) => d.id === defaultDashboardId)
    ? defaultDashboardId
    : (dashboards[0]?.id ?? null);
  // Devices only: drop composite / areas-backed virtual systems — they're a dashboard/area construct,
  // not a physical device, and are slated for removal. Public grid-data sources (e.g. OpenElectricity,
  // vendorType "openelectricity") count as physical and stay.
  const devices = availableSystems.filter((s) => s.vendorType !== "composite");

  // Separate owned vs granted systems
  const ownedSystems = devices
    .filter((s) => s.ownerClerkUserId === userId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Public (ownerless) systems are visible to everyone.
  const publicSystems = devices
    .filter((s) => s.ownerClerkUserId == null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const grantedSystems = devices
    .filter((s) => s.ownerClerkUserId != null && s.ownerClerkUserId !== userId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const handleClick = (systemId: number) => {
    if (onSystemSelect) {
      onSystemSelect(systemId);
    }
  };

  const renderSystemItem = (system: AvailableSystem) => {
    const isActive = currentSystemId && system.id === parseInt(currentSystemId);
    const isDefault = defaultSystemId === system.id;
    const displayText = system.displayName || `System ${system.vendorSiteId}`;

    if (isMobile) {
      return (
        <button
          key={system.id}
          onClick={() => handleClick(system.id)}
          className={`${itemClassName} ${isActive ? activeItemClassName : ""} ${
            system.id.toString() === currentSystemId
              ? "text-blue-400 bg-gray-700/50"
              : ""
          } flex items-center gap-2`}
        >
          <span>{displayText}</span>
          {isDefault && (
            <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400 flex-shrink-0" />
          )}
        </button>
      );
    }

    // Desktop version uses Link
    // Use search params from the URL if available, and preserve subpage path
    const { queryString, subpage } =
      typeof window !== "undefined"
        ? (() => {
            const searchParams = new URLSearchParams(window.location.search);
            const qs = preserveQueryParams
              .filter((param) => searchParams.has(param))
              .map((param) => `${param}=${searchParams.get(param)}`)
              .join("&");

            // Extract subpage from current path (e.g., /heatmap from /device/user/system/heatmap)
            const pathParts = window.location.pathname
              .split("/")
              .filter(Boolean);
            // Path structure: dashboard / [identifier...] / [subpage]
            // Subpages are: heatmap, generator, amber, latest
            const knownSubpages = ["heatmap", "generator", "amber", "latest"];
            const lastPart = pathParts[pathParts.length - 1];
            // Only preserve /amber subpage if target system is amber vendorType
            const sp = knownSubpages.includes(lastPart)
              ? lastPart === "amber" && system.vendorType !== "amber"
                ? ""
                : `/${lastPart}`
              : "";

            return { queryString: qs, subpage: sp };
          })()
        : { queryString: "", subpage: "" };

    // Prefer username/shortname path if available, otherwise use system ID
    const basePath =
      system.ownerUsername && system.alias
        ? `/device/${system.ownerUsername}/${system.alias}`
        : `/device/${system.id}`;
    const fullPath = `${basePath}${subpage}`;
    const href = queryString ? `${fullPath}?${queryString}` : fullPath;

    return (
      <Link
        key={system.id}
        href={href}
        className={`${itemClassName} ${isActive ? activeItemClassName : ""} flex items-center gap-2`}
        onClick={() => handleClick(system.id)}
      >
        <span>{displayText}</span>
        {isDefault && (
          <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400 flex-shrink-0" />
        )}
      </Link>
    );
  };

  return (
    <div className={className}>
      {/* Owned systems */}
      {ownedSystems.map(renderSystemItem)}

      {/* Public (ownerless) systems */}
      {ownedSystems.length > 0 && publicSystems.length > 0 && (
        <div className="border-t border-gray-700 my-1"></div>
      )}
      {publicSystems.map(renderSystemItem)}

      {/* Granted systems */}
      {(ownedSystems.length > 0 || publicSystems.length > 0) &&
        grantedSystems.length > 0 && (
          <div className="border-t border-gray-700 my-1"></div>
        )}
      {grantedSystems.map(renderSystemItem)}

      {/* Cross-nav back to the dashboards world — symmetric with DashboardsMenu's "Go to Devices". */}
      {goToDashboardId != null && (
        <>
          <div className="border-t border-gray-700 my-1"></div>
          <Link
            href={`/dashboard/id/${goToDashboardId}`}
            onClick={onNavigate}
            className={`${itemClassName} flex items-center gap-2 text-gray-300 hover:text-white ${
              isMobile ? "first:rounded-t-lg last:rounded-b-lg" : ""
            }`}
          >
            <LayoutDashboard className="w-4 h-4" />
            Go to Dashboards
          </Link>
        </>
      )}
    </div>
  );
}
