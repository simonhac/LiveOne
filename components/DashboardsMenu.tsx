"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Star, Plus } from "lucide-react";
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
    </div>
  );
}
