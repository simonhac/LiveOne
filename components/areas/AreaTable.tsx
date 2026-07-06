"use client";

import { MapPin, Pencil, Plus } from "lucide-react";
import type {
  AdminAreaData,
  AreaSourceSystem,
} from "@/lib/admin/get-areas-data";

/**
 * The Areas table — the presentational surface shared by the admin view (`/admin/areas`, all owners)
 * and the owner-facing view (`/areas`, the caller's own sites). Pure + prop-driven: it lists areas and
 * exposes New/Edit callbacks; the parent owns the `AreaBuilderDialog` and the create/edit state.
 */

/**
 * Format an area's source systems: "drawn from Kinkora Fronius and ID: 9".
 * Uses the display name where available, falling back to "ID: X".
 */
function formatSourceSystems(systems: AreaSourceSystem[]): string {
  if (systems.length === 0) return "(no systems)";
  const formatted = systems.map((s) => s.displayName || `ID: ${s.id}`);
  if (formatted.length === 1) return `drawn from ${formatted[0]}`;
  if (formatted.length === 2)
    return `drawn from ${formatted[0]} and ${formatted[1]}`;
  const allButLast = formatted.slice(0, -1).join(", ");
  return `drawn from ${allButLast} and ${formatted[formatted.length - 1]}`;
}

function formatLocation(area: AdminAreaData): string | null {
  const loc = area.location;
  if (!loc) return null;
  const parts = [loc.state, loc.postcode, loc.country].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function AreaTable({
  title,
  subtitle,
  icon,
  areas,
  onNew,
  onEdit,
  newLabel = "New site",
  emptyLabel = "No areas",
  showOwner = true,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  areas: AdminAreaData[];
  onNew: () => void;
  onEdit: (areaId: string) => void;
  newLabel?: string;
  emptyLabel?: string;
  /** Show the Owner column (admin view). Off for the owner view, where every row is the caller. */
  showOwner?: boolean;
}) {
  // Area, [Owner], Bindings, Timezone, (edit)
  const colSpan = showOwner ? 5 : 4;
  return (
    <div className="bg-gray-800 border border-gray-700 md:rounded overflow-hidden flex flex-col">
      <div className="px-2 md:px-6 py-4 border-b border-gray-700 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            {icon}
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            <span className="text-sm text-gray-500">({areas.length})</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
        </div>
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-700 whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          {newLabel}
        </button>
      </div>

      <div className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Area
              </th>
              {showOwner && (
                <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Owner
                </th>
              )}
              <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Bindings
              </th>
              <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Timezone
              </th>
              <th className="px-2 md:px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {areas.length === 0 ? (
              <tr>
                <td
                  colSpan={colSpan}
                  className="px-2 md:px-6 py-6 text-sm text-gray-500 text-center"
                >
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              areas.map((area) => {
                const location = formatLocation(area);
                const sourceLine = formatSourceSystems(area.memberSystems);
                return (
                  <tr
                    key={area.id}
                    className="hover:bg-gray-700/50 transition-colors"
                  >
                    <td className="px-2 md:px-6 py-4 align-top">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">
                          {area.displayName}
                        </span>
                        {area.alias && (
                          <span className="text-sm text-gray-400">
                            ({area.alias})
                          </span>
                        )}
                        {area.legacySystemId != null && (
                          <span className="text-sm text-gray-500">
                            ID: {area.legacySystemId}
                          </span>
                        )}
                        {area.status !== "active" && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-300 border border-orange-700">
                            {area.status}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {sourceLine}
                      </div>
                      {location && (
                        <div className="flex items-center gap-1 text-xs text-gray-500 mt-0.5">
                          <MapPin className="w-3 h-3" />
                          {location}
                        </div>
                      )}
                    </td>
                    {showOwner && (
                      <td className="px-2 md:px-6 py-4 align-top">
                        {area.owner.email ? (
                          <a
                            href={`mailto:${area.owner.email}`}
                            className="text-xs text-gray-400 hover:text-blue-400 transition-colors"
                          >
                            {area.owner.email}
                          </a>
                        ) : (
                          <span className="text-xs text-gray-500">
                            {area.owner.userName || "—"}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-2 md:px-6 py-4 align-top">
                      <span className="text-sm text-gray-300">
                        {area.bindingCount}
                      </span>
                    </td>
                    <td className="px-2 md:px-6 py-4 align-top">
                      <span className="text-xs text-gray-400">
                        {area.displayTimezone}
                      </span>
                    </td>
                    <td className="px-2 md:px-6 py-4 align-top text-right">
                      <button
                        onClick={() => onEdit(area.id)}
                        title="Edit area"
                        className="inline-flex items-center gap-1 rounded-md border border-gray-600 px-2 py-1 text-xs text-gray-300 transition-colors hover:text-white hover:border-gray-500"
                      >
                        <Pencil className="w-3 h-3" />
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
