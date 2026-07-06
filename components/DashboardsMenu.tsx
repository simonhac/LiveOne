"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Star, Plus, HardDrive, Layers, Users } from "lucide-react";
import { myDashboardsQuery, userPreferencesQuery } from "@/lib/queries";

interface DashboardsMenuProps {
  /** The composition dashboard currently being viewed, to highlight it (undefined on legacy pages). */
  currentDashboardId?: number;
  /** Only fetch for a real authed owner (off in the read-only shared view). */
  enabled?: boolean;
  /** Close the parent dropdown after picking a row / choosing "New". */
  onNavigate?: () => void;
  /** Open the "New dashboard" dialog (owned by the parent so it survives the dropdown closing). */
  onNew: () => void;
  className?: string;
  itemClassName?: string;
  activeItemClassName?: string;
  isMobile?: boolean;
}

/**
 * Warm the switcher's data (dashboards + default-preference) into the React Query cache while the
 * page is mounted, so the dropdown paints fully populated on its FIRST open instead of flashing just
 * the "New dashboard…" row and then reflowing. The menu only mounts when the dropdown opens, so
 * without this its own queries don't fire until then. Same query keys → this dedupes with the menu's
 * own `useQuery`; a single fetch, shared cache. Gate with `enabled` so closed/shared views don't fetch.
 */
export function usePrefetchDashboardsMenu(enabled = true) {
  useQuery(myDashboardsQuery(enabled));
  useQuery(userPreferencesQuery(enabled));
}

/**
 * The contents of the header title dropdown — the signed-in user's composition dashboards. A drop-in
 * repurpose of `SystemsMenu`: same row styling + default star, but rows link to `/dashboard/id/{id}`
 * and the data is client-fetched (react-query, invalidated by create/rename/delete) rather than passed
 * in. A footer "New dashboard…" row creates one (its dialog is owned by the parent, reached via onNew).
 */
export default function DashboardsMenu({
  currentDashboardId,
  enabled = true,
  onNavigate,
  onNew,
  className = "",
  itemClassName = "block px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors",
  activeItemClassName = "bg-gray-700",
  isMobile = false,
}: DashboardsMenuProps) {
  const { data, isLoading } = useQuery(myDashboardsQuery(enabled));
  const { data: prefs } = useQuery(userPreferencesQuery(enabled));

  const dashboards = data?.dashboards ?? [];
  const defaultId = prefs?.preferences.defaultDashboardId ?? null;

  return (
    <div className={className}>
      {dashboards.length === 0 && !isLoading && (
        <div className="px-4 py-2 text-sm text-gray-500">No dashboards yet</div>
      )}

      {dashboards.map((d) => {
        const isActive = d.id === currentDashboardId;
        const isDefault = d.id === defaultId;
        const isShared = d.access === "shared";
        return (
          <Link
            key={d.id}
            href={`/dashboard/id/${d.id}`}
            onClick={onNavigate}
            className={`${itemClassName} ${isActive ? activeItemClassName : ""} flex items-center gap-2`}
          >
            <span className="truncate">{d.displayName ?? "Untitled"}</span>
            {isDefault && (
              <Star className="h-3.5 w-3.5 flex-shrink-0 fill-yellow-400 text-yellow-400" />
            )}
            {isShared && (
              <Users
                className="h-3.5 w-3.5 flex-shrink-0 text-gray-400"
                aria-label="Shared with you"
              />
            )}
          </Link>
        );
      })}

      {dashboards.length > 0 && (
        <div className="my-1 border-t border-gray-700" />
      )}

      <button
        onClick={() => {
          onNew();
          onNavigate?.();
        }}
        className={`${itemClassName} flex w-full items-center gap-2 text-left text-gray-300 hover:text-white ${
          isMobile ? "first:rounded-t-lg last:rounded-b-lg" : ""
        }`}
      >
        <Plus className="h-4 w-4" />
        New dashboard…
      </button>

      {/* Manage the owner's Areas/sites (the /areas list — browse, edit, create). */}
      <div className="my-1 border-t border-gray-700" />
      <Link
        href="/areas"
        onClick={onNavigate}
        className={`${itemClassName} flex items-center gap-2 text-gray-300 hover:text-white ${
          isMobile ? "first:rounded-t-lg last:rounded-b-lg" : ""
        }`}
      >
        <Layers className="h-4 w-4" />
        Manage sites
      </Link>

      {/* Cross-nav to the systems/devices world — `/device` redirects to the first visible system,
          whose header dropdown is the symmetric SystemsMenu (with "Go to Dashboards"). */}
      <div className="my-1 border-t border-gray-700" />
      <Link
        href="/device"
        onClick={onNavigate}
        className={`${itemClassName} flex items-center gap-2 text-gray-300 hover:text-white ${
          isMobile ? "first:rounded-t-lg last:rounded-b-lg" : ""
        }`}
      >
        <HardDrive className="h-4 w-4" />
        Go to Devices
      </Link>
    </div>
  );
}
