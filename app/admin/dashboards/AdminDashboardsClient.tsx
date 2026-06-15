"use client";

import { LayoutDashboard, Share2, Users } from "lucide-react";
import type { AdminDashboardRow } from "@/lib/admin/get-dashboards-data";

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminDashboardsClient({
  dashboards,
}: {
  dashboards: AdminDashboardRow[];
}) {
  return (
    <div className="flex flex-col h-full max-h-full">
      <div className="flex-1 px-0 md:px-6 py-8 overflow-auto">
        <div className="bg-gray-800 border border-gray-700 md:rounded overflow-hidden flex flex-col">
          <div className="px-2 md:px-6 py-4 border-b border-gray-700">
            <div className="flex items-center gap-2">
              <LayoutDashboard className="w-5 h-5 text-blue-400" />
              <h2 className="text-lg font-semibold text-white">Dashboards</h2>
              <span className="text-sm text-gray-500">
                ({dashboards.length})
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Per-user dashboard customizations, keyed on (owner, system).
            </p>
          </div>

          <div className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Owner
                  </th>
                  <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Target
                  </th>
                  <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Cards
                  </th>
                  <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Sharing
                  </th>
                  <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {dashboards.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-2 md:px-6 py-6 text-sm text-gray-500 text-center"
                    >
                      No dashboards
                    </td>
                  </tr>
                ) : (
                  dashboards.map((d) => (
                    <tr
                      key={d.id}
                      className="hover:bg-gray-700/50 transition-colors"
                    >
                      <td className="px-2 md:px-6 py-4 align-top">
                        {d.owner.email ? (
                          <a
                            href={`mailto:${d.owner.email}`}
                            className="text-xs text-gray-400 hover:text-blue-400 transition-colors"
                          >
                            {d.owner.email}
                          </a>
                        ) : (
                          <span className="text-xs text-gray-500">
                            {d.owner.userName || d.owner.clerkId}
                          </span>
                        )}
                      </td>
                      <td className="px-2 md:px-6 py-4 align-top">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-white">
                            {d.systemName || `System ${d.systemId}`}
                          </span>
                          <span className="text-sm text-gray-500">
                            ID: {d.systemId}
                          </span>
                        </div>
                        {d.areaId && (
                          <div className="text-xs text-gray-500 mt-0.5 font-mono">
                            area {d.areaId.slice(0, 8)}…
                          </div>
                        )}
                      </td>
                      <td className="px-2 md:px-6 py-4 align-top">
                        <span className="text-sm text-gray-300">
                          {d.cardCount}
                        </span>
                      </td>
                      <td className="px-2 md:px-6 py-4 align-top">
                        <div className="flex items-center gap-3">
                          <span
                            className="flex items-center gap-1 text-xs text-gray-400"
                            title="Share tokens"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                            {d.shareTokenCount}
                          </span>
                          <span
                            className="flex items-center gap-1 text-xs text-gray-400"
                            title="Grants"
                          >
                            <Users className="w-3.5 h-3.5" />
                            {d.grantCount}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 md:px-6 py-4 align-top whitespace-nowrap">
                        <span className="text-xs text-gray-400">
                          {formatDateTime(d.updatedAt)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
