"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Settings, Plus, Layers, ChevronDown } from "lucide-react";
import { DashboardV4View } from "@/components/dashboard/v4/node-view";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import DashboardSettingsDialog from "@/components/DashboardSettingsDialog";
import DashboardsMenu, {
  usePrefetchDashboardsMenu,
} from "@/components/DashboardsMenu";
import NewDashboardDialog from "@/components/NewDashboardDialog";
import AddAreaDialog from "@/components/AddAreaDialog";
import AreaBuilderDialog from "@/components/area-builder/AreaBuilderDialog";
import { readableAreasQuery } from "@/lib/queries";
import { docAreaRefs, docHasCards } from "@/lib/dashboard/add-area";
import {
  hasTimeTravelingCard,
  primaryHandle,
} from "@/lib/dashboard/temporal-cards";
import { HeaderTemporalNav } from "@/components/dashboard/HeaderTemporalNav";
import { ChartFocusProvider } from "@/lib/charts/ChartFocusContext";
import type { ReadableArea } from "@/lib/areas/list";
import type { ReadableDevice } from "@/lib/devices/list";
import type { ResolvedDevice } from "@/lib/dashboard/resolve-shell";

// Shared styling for the header cog menu's action items (mirrors FlowsSettingsMenu's ITEM_CLASS).
const MENU_ITEM_CLASS =
  "flex items-center gap-2 px-3 py-2 text-sm rounded outline-none cursor-pointer " +
  "text-gray-300 hover:bg-gray-700 data-[highlighted]:bg-gray-700";

interface DashboardClientProps {
  dashboard: {
    id: string; // config-v4: the `db_…` TypeID (used verbatim in URLs; routes decode it)
    displayName: string | null;
    alias: string | null;
    /**
     * The v4 node tree — the ONLY shape this shell knows about since Phase 14 stage 14 moved the
     * last authoring surface (`AddAreaDialog`) and the settings dialog's area list off `descriptor`.
     * `dashboards.doc` is NOT NULL (Phase 8/10 cutover) and every write path validates it, so the
     * page always has one; a doc that fails the shape guard arrives as an empty document rather than
     * falling back to a second renderer.
     */
    doc: DashboardV4;
    /**
     * `dashboards.revision` as of this render — the `If-Match` precondition `AddAreaDialog` sends
     * with its whole-document `PUT` (clean-sheet §9.1). Without it two tabs silently clobber.
     */
    revision: number;
  };
  /** Owner or admin → may rename/delete/switch. */
  canEdit: boolean;
  /** Read-only shared view: referenced Areas resolved server-side (no authed areas fetch). */
  sharedAreas?: ReadableArea[];
  /**
   * Owner/admin authed view: the caller's full readable Areas resolved server-side (SSR seed), so the
   * client skips the `/api/v4/areas` round-trip on load (SP1.1) while keeping the switcher +
   * editor. Distinct from `sharedAreas`, which also flags the read-only shared view.
   */
  initialReadableAreas?: ReadableArea[];
  /** Device refs already resolved and authorized by the server render path. */
  resolvedDevices?: ReadableDevice[];
}

export default function DashboardClient({
  dashboard,
  canEdit,
  sharedAreas,
  initialReadableAreas,
  resolvedDevices = [],
}: DashboardClientProps) {
  const router = useRouter();
  const [renameOpen, setRenameOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [addAreaOpen, setAddAreaOpen] = useState(false);
  const [createAreaOpen, setCreateAreaOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Warm the switcher's dashboards + default so the dropdown paints fully on first open (no jump).
  // The switcher is only shown to a real authed owner (not the read-only shared view).
  usePrefetchDashboardsMenu(!sharedAreas);

  // areaId → Area: the shared view gets them inline (sharedAreas); an authed owner is seeded from SSR
  // (initialReadableAreas) so the query resolves without a client fetch; otherwise it fetches.
  const areasQuery = useQuery({
    ...readableAreasQuery(!sharedAreas),
    ...(initialReadableAreas
      ? { initialData: { areas: initialReadableAreas } }
      : {}),
  });
  const readableAreas: ReadableArea[] = useMemo(
    () => sharedAreas ?? areasQuery.data?.areas ?? [],
    [sharedAreas, areasQuery.data?.areas],
  );
  // Whether the readable-Area set is KNOWN (not still loading): a shared/grant view has them
  // inline; the authed owner/admin view is SSR-seeded (initialData ⇒ success on the first render);
  // otherwise we wait for the fetch to settle. Once resolved, a section whose Area still can't be
  // found is a genuine unresolved reference (removed, or — common in local dev, where you sign in as
  // a Clerk *dev* user who may not own/have the synced Areas shared to them — no access). Dashboard
  // surfaces that instead of spinning a skeleton forever.
  const areasResolved = sharedAreas != null || areasQuery.isSuccess;
  const areaById = useMemo(
    () => new Map(readableAreas.map((a) => [a.id, a] as const)),
    [readableAreas],
  );
  const deviceById = useMemo(
    () =>
      new Map<string, ResolvedDevice>(
        resolvedDevices.map((device) => [
          device.id,
          {
            deviceId: device.id,
            name: device.name,
            systemId: device.systemId,
          },
        ]),
      ),
    [resolvedDevices],
  );

  // The single page-header temporal navigator: shown only when this dashboard actually hosts a
  // time-traveling component, formatted in the first section's timezone. It drives every chart on
  // the page via the shared URL window.
  const showNav = hasTimeTravelingCard(dashboard.doc, areaById);
  const navHandle = primaryHandle(dashboard.doc, areaById);

  return (
    <ChartFocusProvider>
      <div className="min-h-screen bg-gray-900">
        <header className="sticky top-0 z-30 border-b border-gray-800 bg-gray-900/80 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
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
            <div className="flex items-center gap-2">
              {/* Temporal navigator, left of the edit cluster (desktop). Mobile → own row below. */}
              {showNav && navHandle != null && (
                <div className="hidden sm:block">
                  <HeaderTemporalNav handle={navHandle} />
                </div>
              )}
              {canEdit && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      title="Dashboard actions"
                      aria-label="Dashboard actions"
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-700 px-2.5 py-1.5 text-sm text-gray-300 outline-none transition-colors hover:bg-gray-800 hover:text-white data-[state=open]:bg-gray-800 data-[state=open]:text-white"
                    >
                      <Settings className="h-4 w-4" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={5}
                      className="min-w-[200px] rounded-lg border border-gray-700 bg-gray-800 p-1 shadow-xl"
                      style={{ zIndex: 9999 }}
                    >
                      <DropdownMenu.Item
                        className={MENU_ITEM_CLASS}
                        onSelect={() => setNewOpen(true)}
                      >
                        <Plus className="h-4 w-4 text-gray-400" />
                        New dashboard
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={MENU_ITEM_CLASS}
                        onSelect={() => setAddAreaOpen(true)}
                      >
                        <Layers className="h-4 w-4 text-gray-400" />
                        Add existing area…
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={MENU_ITEM_CLASS}
                        onSelect={() => setCreateAreaOpen(true)}
                      >
                        <Plus className="h-4 w-4 text-gray-400" />
                        Create new area…
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator className="my-1 h-px bg-gray-700" />
                      <DropdownMenu.Item
                        className={MENU_ITEM_CLASS}
                        onSelect={() => setRenameOpen(true)}
                      >
                        <Settings className="h-4 w-4 text-gray-400" />
                        Settings…
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>
            {showNav && navHandle != null && (
              <div className="w-full sm:hidden">
                <HeaderTemporalNav handle={navHandle} />
              </div>
            )}
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-1 py-4">
          {docHasCards(dashboard.doc) ? (
            <DashboardV4View
              doc={dashboard.doc}
              areaById={areaById}
              dashboardId={dashboard.id}
              areasResolved={areasResolved}
              deviceById={deviceById}
            />
          ) : (
            // A brand-new dashboard has an empty document, and `DashboardV4View` renders literally
            // nothing for it. The v3 renderer used to own this state; Phase 8/10 made it unreachable
            // and stage 9's deletion of that renderer made it permanent, so it lives here now — the
            // shell owns the empty case because the shell owns the dialog it opens.
            <div className="mx-auto max-w-md px-4 py-16 text-center text-gray-400">
              <Layers className="mx-auto mb-3 h-10 w-10 text-gray-600" />
              <p className="text-sm">
                This dashboard has no cards yet.
                {canEdit ? " Add an area to get started." : ""}
              </p>
              {canEdit && (
                <button
                  onClick={() => setAddAreaOpen(true)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
                >
                  <Layers className="h-4 w-4" />
                  Add area
                </button>
              )}
            </div>
          )}
        </main>

        {canEdit && (
          <>
            <DashboardSettingsDialog
              isOpen={renameOpen}
              onClose={() => setRenameOpen(false)}
              id={dashboard.id}
              initialName={dashboard.displayName ?? ""}
              initialAlias={dashboard.alias ?? ""}
              areaIds={docAreaRefs(dashboard.doc)}
              onDeleted={() => router.push("/dashboard")}
              onSaved={() => router.refresh()}
            />
            <AddAreaDialog
              isOpen={addAreaOpen}
              onClose={() => setAddAreaOpen(false)}
              dashboardId={dashboard.id}
              doc={dashboard.doc}
              revision={dashboard.revision}
              readableAreas={readableAreas}
              onSaved={() => router.refresh()}
            />
            <NewDashboardDialog
              isOpen={newOpen}
              onClose={() => setNewOpen(false)}
            />
            <AreaBuilderDialog
              isOpen={createAreaOpen}
              areaId={null}
              onClose={() => setCreateAreaOpen(false)}
              onSaved={() => router.refresh()}
            />
          </>
        )}
      </div>
    </ChartFocusProvider>
  );
}
