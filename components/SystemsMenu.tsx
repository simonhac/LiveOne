"use client";

import Link from "next/link";
import { Star } from "lucide-react";

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
  preserveQueryParams = ["period"],
  className = "",
  itemClassName = "block px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors",
  activeItemClassName = "bg-gray-700",
  isMobile = false,
}: SystemsMenuProps) {
  // Separate owned vs granted systems
  const ownedSystems = availableSystems
    .filter((s) => s.ownerClerkUserId === userId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const grantedSystems = availableSystems
    .filter((s) => s.ownerClerkUserId !== userId)
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

            // Extract subpage from current path (e.g., /heatmap from /dashboard/user/system/heatmap)
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
        ? `/dashboard/${system.ownerUsername}/${system.alias}`
        : `/dashboard/${system.id}`;
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

      {/* Divider if both groups exist */}
      {ownedSystems.length > 0 && grantedSystems.length > 0 && (
        <div className="border-t border-gray-700 my-1"></div>
      )}

      {/* Granted systems */}
      {grantedSystems.map(renderSystemItem)}

      {/* Admin note for many systems */}
      {isAdmin && availableSystems.length >= 10 && (
        <div className="px-4 py-2 text-xs text-gray-500 border-t border-gray-700">
          Showing first {availableSystems.length} systems
        </div>
      )}
    </div>
  );
}
