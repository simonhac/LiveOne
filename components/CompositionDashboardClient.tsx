"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Pencil, Settings2, Trash2, Plus, X } from "lucide-react";
import CompositionDashboard from "@/components/CompositionDashboard";
import DashboardCustomizeDialog from "@/components/DashboardCustomizeDialog";
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
          <h1 className="truncate text-lg font-semibold text-white">
            {dashboard.displayName ?? "Dashboard"}
          </h1>
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
          <RenameDialog
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

/** Rename / set shortname / delete a composition dashboard. */
function RenameDialog({
  isOpen,
  onClose,
  id,
  initialName,
  initialAlias,
  onDeleted,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  id: number;
  initialName: string;
  initialAlias: string;
  onDeleted: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [alias, setAlias] = useState(initialAlias);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || typeof document === "undefined") return null;

  const save = async () => {
    if (!name.trim()) {
      setError("Name cannot be empty");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name.trim(), alias: alias.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Could not save");
        return;
      }
      onClose();
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this dashboard? This cannot be undone.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/dashboards/${id}`, { method: "DELETE" });
      if (res.ok) {
        onClose();
        onDeleted();
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[10000] bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[10001] flex items-center justify-center px-4">
        <div className="pointer-events-auto w-full max-w-[460px] rounded-lg border border-gray-700 bg-gray-800 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-700 px-6 py-4">
            <h2 className="text-lg font-semibold text-white">
              Dashboard settings
            </h2>
            <button
              onClick={onClose}
              className="rounded p-1 transition-colors hover:bg-gray-700"
            >
              <X className="h-5 w-5 text-gray-400" />
            </button>
          </div>
          <div className="space-y-4 px-6 py-4">
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
                Shortname (optional)
              </span>
              <input
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="e.g. home-farm"
                className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600"
              />
            </label>
            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-gray-700 px-6 py-4">
            <button
              onClick={remove}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-950/40 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                disabled={busy}
                className="rounded-md border border-gray-600 px-4 py-2 text-gray-300 transition-colors hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={busy || !name.trim()}
                className="min-w-[90px] rounded-md bg-blue-600 px-5 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
