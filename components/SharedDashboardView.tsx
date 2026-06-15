"use client";

import DashboardClient from "@/components/DashboardClient";
import { DashboardCustomizeProvider } from "@/contexts/DashboardCustomizeContext";
import type { DashboardDescriptor } from "@/lib/dashboard/descriptor";
import type { GridContext } from "@/lib/grid/types";

/**
 * Read-only public view of a shared dashboard (P4). Reached via `/dashboard/...?access=<token>` — no
 * sign-in. Deliberately minimal chrome (no system switcher / owner controls): just the dashboard name
 * + a "shared" badge wrapping a read-only `DashboardClient`. The share token in the page URL is
 * propagated to all `/api/` queries by `lib/queries/fetcher.ts`. `DashboardCustomizeProvider` is
 * supplied here because `DashboardClient` requires it (normally provided by `DashboardLayout`).
 */
export default function SharedDashboardView({
  systemId,
  system,
  serveFlowFromPg,
  gridContext,
  hasGenerator,
  sharedDescriptor,
}: {
  systemId: string;
  system: unknown;
  serveFlowFromPg: boolean;
  gridContext: GridContext | null;
  hasGenerator: boolean;
  sharedDescriptor: DashboardDescriptor | null;
}) {
  const displayName =
    (system as { displayName?: string } | null)?.displayName ?? "Dashboard";
  return (
    <DashboardCustomizeProvider>
      <div className="min-h-screen bg-gray-900">
        <header className="border-b border-gray-800 bg-gray-900/80 px-4 py-3">
          <div className="mx-auto flex max-w-7xl items-center justify-between">
            <h1 className="text-lg font-semibold text-white">{displayName}</h1>
            <span className="rounded-full bg-gray-800 px-3 py-1 text-xs text-gray-400">
              Shared · read-only
            </span>
          </div>
        </header>
        <DashboardClient
          systemId={systemId}
          system={system}
          hasAccess
          systemExists
          isAdmin={false}
          availableSystems={[]}
          serveFlowFromPg={serveFlowFromPg}
          gridContext={gridContext}
          hasGenerator={hasGenerator}
          readOnly
          sharedDescriptor={sharedDescriptor}
        />
      </div>
    </DashboardCustomizeProvider>
  );
}
