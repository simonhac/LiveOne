"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Pencil, Settings2, Plus, ChevronDown } from "lucide-react";
import CompositionDashboard from "@/components/CompositionDashboard";
import DashboardCustomizeDialog from "@/components/DashboardCustomizeDialog";
import DashboardSettingsDialog from "@/components/DashboardSettingsDialog";
import DashboardsMenu from "@/components/DashboardsMenu";
import NewDashboardDialog from "@/components/NewDashboardDialog";
import { readableAreasQuery } from "@/lib/queries";
import type { DashboardDescriptor } from "@/lib/dashboard/descriptor";
import type { DashboardCardType, TileId } from "@/lib/dashboard/cards";
import type { ReadableArea } from "@/lib/areas/list";
import type { GridContext } from "@/lib/grid/types";

interface CompositionDashboardClientProps {
  dashboard: {
    id: number;
    displayName: string | null;
    alias: string | null;
    descriptor: DashboardDescriptor;
  };
  /** Owner or admin → may customize/rename/delete. */
  canEdit: boolean;
  /** Read-only shared view: referenced Areas resolved server-side (no authed areas fetch). */
  sharedAreas?: ReadableArea[];
  /** Server-resolved NEM region per Area that has a grid-signals card. */
  gridContextByArea?: Record<string, GridContext | null>;
  serveFlowFromPg?: boolean;
}

const EMPTY_MODULES = new Set<DashboardCardType>();
const EMPTY_TILES = new Set<TileId>();
const EMPTY_TILE_NODES = {} as Record<TileId, ReactNode>;

export default function CompositionDashboardClient({
  dashboard,
  canEdit,
  sharedAreas,
  gridContextByArea = {},
  serveFlowFromPg = false,
}: CompositionDashboardClientProps) {
  const router = useRouter();
  const [descriptor, setDescriptor] = useState<DashboardDescriptor>(
    dashboard.descriptor,
  );
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // areaId → Area: authed views fetch the caller's readable areas; the shared view gets them inline.
  const { data: areasResp } = useQuery(readableAreasQuery(!sharedAreas));
  const readableAreas: ReadableArea[] = sharedAreas ?? areasResp?.areas ?? [];
  const areaById = useMemo(
    () => new Map(readableAreas.map((a) => [a.id, a] as const)),
    [readableAreas],
  );

  const saveDescriptor = async (next: DashboardDescriptor) => {
    const res = await fetch(`/api/dashboards/${dashboard.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ descriptor: next }),
    });
    if (res.ok) setDescriptor(next);
    setCustomizeOpen(false);
  };

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="border-b border-gray-800 bg-gray-900/80 px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="relative min-w-0">
            {sharedAreas ? (
              <h1 className="truncate text-lg font-semibold text-white">
                {dashboard.displayName ?? "Dashboard"}
              </h1>
            ) : (
              <button
                onClick={() => setSwitcherOpen((o) => !o)}
                className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-gray-800"
              >
                <h1 className="truncate text-lg font-semibold text-white">
                  {dashboard.displayName ?? "Dashboard"}
                </h1>
                <ChevronDown
                  className={`h-4 w-4 flex-shrink-0 text-gray-400 transition-transform ${switcherOpen ? "rotate-180" : ""}`}
                />
              </button>
            )}
            {switcherOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setSwitcherOpen(false)}
                />
                <div className="absolute left-0 top-full z-50 mt-2 w-64 rounded-lg border border-gray-700 bg-gray-800 shadow-lg">
                  <DashboardsMenu
                    currentDashboardId={dashboard.id}
                    enabled={!sharedAreas}
                    onNew={() => setNewOpen(true)}
                    onNavigate={() => setSwitcherOpen(false)}
                  />
                </div>
              </>
            )}
          </div>
          {canEdit && (
            <div className="flex items-center gap-1">
              <HeaderButton
                title="Customize cards"
                onClick={() => setCustomizeOpen(true)}
              >
                <Settings2 className="h-4 w-4" />
                <span className="hidden sm:inline">Customize</span>
              </HeaderButton>
              <HeaderButton title="Rename" onClick={() => setRenameOpen(true)}>
                <Pencil className="h-4 w-4" />
              </HeaderButton>
              <HeaderButton
                title="New dashboard"
                onClick={() => setNewOpen(true)}
              >
                <Plus className="h-4 w-4" />
              </HeaderButton>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-1 py-4">
        <CompositionDashboard
          descriptor={descriptor}
          areaById={areaById}
          gridContextByArea={gridContextByArea}
          serveFlowFromPg={serveFlowFromPg}
        />
      </main>

      {canEdit && (
        <>
          <DashboardCustomizeDialog
            isOpen={customizeOpen}
            onClose={() => setCustomizeOpen(false)}
            descriptor={descriptor}
            availableModules={EMPTY_MODULES}
            availablePower={EMPTY_TILES}
            powerCardNodes={EMPTY_TILE_NODES}
            readableAreas={readableAreas}
            onSave={saveDescriptor}
            onReset={async () => setCustomizeOpen(false)}
          />
          <DashboardSettingsDialog
            isOpen={renameOpen}
            onClose={() => setRenameOpen(false)}
            id={dashboard.id}
            initialName={dashboard.displayName ?? ""}
            initialAlias={dashboard.alias ?? ""}
            onDeleted={() => router.push("/dashboard")}
            onSaved={() => router.refresh()}
          />
          <NewDashboardDialog
            isOpen={newOpen}
            onClose={() => setNewOpen(false)}
          />
        </>
      )}
    </div>
  );
}

function HeaderButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-700 px-2.5 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
    >
      {children}
    </button>
  );
}
