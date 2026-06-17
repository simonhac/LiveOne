"use client";

import { Layers, MapPin } from "lucide-react";
import type {
  AdminAreaData,
  AreaSourceSystem,
} from "@/lib/admin/get-areas-data";

/**
 * Format an area's source systems: "(drawn from Kinkora Fronius and ID: 9)".
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

export default function AdminAreasClient({
  areas,
}: {
  areas: AdminAreaData[];
}) {
  return (
    <div className="flex flex-col h-full max-h-full">
      <div className="flex-1 px-0 md:px-6 py-8 overflow-auto space-y-8">
        <AreaTable
          title="Areas"
          subtitle="Each Area groups 1..N member devices; bindings are role→point overrides."
          icon={<Layers className="w-5 h-5 text-purple-400" />}
          areas={areas}
        />
      </div>
    </div>
  );
}

function AreaTable({
  title,
  subtitle,
  icon,
  areas,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  areas: AdminAreaData[];
}) {
  return (
    <div className="bg-gray-800 border border-gray-700 md:rounded overflow-hidden flex flex-col">
      <div className="px-2 md:px-6 py-4 border-b border-gray-700">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <span className="text-sm text-gray-500">({areas.length})</span>
        </div>
        <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
      </div>

      <div className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Area
              </th>
              <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Owner
              </th>
              <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Bindings
              </th>
              <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Timezone
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {areas.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-2 md:px-6 py-6 text-sm text-gray-500 text-center"
                >
                  No areas
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
