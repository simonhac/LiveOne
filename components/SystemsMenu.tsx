"use client";

import Link from "next/link";

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface SystemsMenuProps {
  availableSystems: AvailableSystem[];
  currentSystemId?: string;
  userId?: string;
  isAdmin?: boolean;
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

    if (isMobile) {
      return (
        <button
          key={system.id}
          onClick={() => handleClick(system.id)}
          className={`${itemClassName} ${isActive ? activeItemClassName : ""} ${
            system.id.toString() === currentSystemId
              ? "text-blue-400 bg-gray-700/50"
              : ""
          }`}
        >
          {system.displayName || `System ${system.vendorSiteId}`}
        </button>
      );
    }

    // Desktop version uses Link
    // Use search params from the URL if available
    const queryString =
      typeof window !== "undefined"
        ? (() => {
            const searchParams = new URLSearchParams(window.location.search);
            return preserveQueryParams
              .filter((param) => searchParams.has(param))
              .map((param) => `${param}=${searchParams.get(param)}`)
              .join("&");
          })()
        : "";

    // Prefer username/shortname path if available, otherwise use system ID
    const basePath =
      system.ownerUsername && system.alias
        ? `/dashboard/${system.ownerUsername}/${system.alias}`
        : `/dashboard/${system.id}`;
    const href = queryString ? `${basePath}?${queryString}` : basePath;

    return (
      <Link
        key={system.id}
        href={href}
        className={`${itemClassName} ${isActive ? activeItemClassName : ""}`}
        onClick={() => handleClick(system.id)}
      >
        {system.displayName || `System ${system.vendorSiteId}`}
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
