"use client";

import { type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { CARD_RENDERERS } from "@/components/dashboard/cards/registry";
import { SiteChartsGroup } from "@/components/dashboard/cards/site-charts";
import { ChartSkeleton } from "@/components/dashboard/cards/shared";
import { dashboardDataBatchQuery } from "@/lib/queries";
import type {
  AreaSectionV3,
  CardV3,
  DashboardCardType,
  DashboardV3,
} from "@/lib/dashboard/v3";
import type { ReadableArea } from "@/lib/areas/list";

/**
 * The nested dashboard renderer. Consumes the v3 definition (Dashboard -> AreaSection -> Card -> Tile,
 * see lib/dashboard/v3.ts) and renders each AreaSection against its Area's handle. There is NO home
 * system: every card self-fetches via the per-systemId query factories (see the plugin modules under
 * components/dashboard/cards/ and /tiles/), and every tile/chart reads either the section's own
 * handle (whole-area) or a named member device.
 *
 * This file is only the descriptor walk + section chrome; every card type renders via its plugin in
 * CARD_RENDERERS (adding a card type = one plugin module + one registry line — the `satisfies`
 * exhaustiveness check enforces it). Render derivations (nothing below is stored in the descriptor):
 *  - handle = area.legacySystemId
 *  - header shown only when there are 2+ sections (single-area page = frameless, like /dashboard/8)
 *  - the stacked-areas charts + sankey of a section collapse into ONE SiteChartsGroup (shared
 *    period), reproducing the legacy unified layout — plugins opt in via `collapseKey`.
 */
function cardKeyV3(card: CardV3, i: number): string {
  return card.id ?? `${card.type}-${i}`;
}

interface DashboardProps {
  /** This dashboard's id — part of the per-sankey options key (`sankeyId:areaId:dashboardId`). Omitted
   *  by the per-device viewer (no saved dashboard) → the sankey options fall back to keying on the handle. */
  dashboardId?: number;
  descriptor: DashboardV3;
  /** areaId -> its Area (addressing handle + label). May be empty while the readable-areas fetch is
   *  in flight — sections still render their skeleton layout from the descriptor in the meantime. */
  areaById: Map<string, ReadableArea>;
  /** Owner/editable view: opens the Add-area dialog from the empty state. Omitted on shared views. */
  onAddArea?: () => void;
}

export default function Dashboard({
  dashboardId,
  descriptor,
  areaById,
  onAddArea,
}: DashboardProps) {
  // Render every section straight from the descriptor — its Area (and so the live data) may not have
  // resolved yet, in which case each card draws a skeleton. We have enough to draw the layout
  // immediately, so there's no "Loading…" gate before the skeletons appear.
  const sections = descriptor.sections.filter((s) => !s.hidden);

  // Best-effort prefetch: when this dashboard's sections span 2+ distinct systems (e.g. a household
  // area + an oe-grid region section), fire ONE /api/data request for all of them and seed each
  // system's own dashboardDataQuery cache — see dashboardDataBatchQuery. Purely additive: every card
  // still self-fetches via useAreaDatum as before, so a slow/absent batch just means no saving, never
  // a regression. No-ops (disabled) below 2 systems.
  const queryClient = useQueryClient();
  const handles = [
    ...new Set(
      sections
        .map((s) => areaById.get(s.areaId)?.legacySystemId)
        .filter((id): id is number => id != null),
    ),
  ];
  useQuery(dashboardDataBatchQuery(handles, queryClient));

  if (sections.length === 0) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-gray-400">
        <Layers className="mx-auto mb-3 h-10 w-10 text-gray-600" />
        <p className="text-sm">
          This dashboard has no cards yet. Add an area to get started.
        </p>
        {onAddArea && (
          <button
            onClick={onAddArea}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
          >
            <Layers className="h-4 w-4" />
            Add area
          </button>
        )}
      </div>
    );
  }

  const showHeaders = sections.length > 1;
  return (
    <div className="space-y-4 px-1">
      {sections.map((section) => (
        <AreaSectionView
          key={section.areaId}
          dashboardId={dashboardId}
          section={section}
          area={areaById.get(section.areaId)}
          showHeader={showHeaders}
        />
      ))}
    </div>
  );
}

/** One Area's cards, stacked. Header only in multi-area dashboards; single-area = frameless (/dashboard/8). */
function AreaSectionView({
  dashboardId,
  section,
  area,
  showHeader,
}: {
  dashboardId?: number;
  section: AreaSectionV3;
  /** Undefined while the readable-areas fetch is in flight → the cards draw skeletons. */
  area?: ReadableArea;
  showHeader: boolean;
}) {
  const handle = area?.legacySystemId;
  const visible = section.cards.filter((c) => !c.hidden);

  // Per-sankey persistence key for the Flows options: `sankeyId:areaId:dashboardId`. `normalizeDescriptor`
  // guarantees a persisted sankey card always has an id; the `?? "sankey"` only covers a legacy row not yet
  // re-saved, and matches the normalizer's own default so the key never drifts. (One sankey per area, so
  // areaId + dashboardId already disambiguate.) No dashboardId (per-device viewer) ⇒ undefined key, and
  // SiteChartsCard falls back to keying on the handle.
  const sankeyCardId = visible.find((c) => c.type === "sankey")?.id ?? "sankey";
  const sankeyOptionsKey =
    dashboardId != null
      ? `${sankeyCardId}:${section.areaId}:${dashboardId}`
      : undefined;

  // Collapse pass 1: collect the section's site-charts keys from every collapse-member card BEFORE
  // anything renders — the single SiteChartsGroup appears at the FIRST member's position but must
  // show ALL members' sub-charts (chart:load / chart:generation / sankey), exactly like the legacy
  // unified layout. `lines` charts are not members (collapseKey → null) and stay standalone.
  const chartKeys = new Set<string>();
  for (const c of visible) {
    const k =
      CARD_RENDERERS[c.type as DashboardCardType]?.collapseKey?.(c) ?? null;
    if (k != null) chartKeys.add(k);
  }
  let chartsEmitted = false;

  // Collapse pass 2 + render: each card renders via its plugin. Cards draw a skeleton until the
  // Area's handle is known (then each leaf self-fetches and shows its own loading state); plugins
  // with `pending: "self"` (tiles) handle the no-handle case internally (skeleton cells).
  const body: ReactNode[] = visible.map((card, i) => {
    const plugin = CARD_RENDERERS[card.type as DashboardCardType];
    // A stale/unknown type in the persisted JSONB degrades to nothing (the old `default:` case).
    if (!plugin) return null;

    if (plugin.collapseKey?.(card) != null) {
      if (chartsEmitted) return null;
      chartsEmitted = true;
      return handle != null ? (
        <SiteChartsGroup
          key="site-charts"
          systemId={handle}
          keys={chartKeys}
          sankeyOptionsKey={sankeyOptionsKey}
          chartCapable={area?.chartCapable}
        />
      ) : (
        <ChartSkeleton key="site-charts" />
      );
    }

    if (plugin.pending !== "self" && handle == null) {
      return <ChartSkeleton key={cardKeyV3(card, i)} />;
    }
    return (
      <plugin.Render
        key={cardKeyV3(card, i)}
        card={card}
        section={section}
        handle={handle}
      />
    );
  });

  return (
    <section
      className={
        showHeader
          ? "rounded-lg border border-gray-700/70 bg-gray-900/30 p-2 sm:p-3"
          : ""
      }
    >
      {showHeader && area && (
        <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
          <Layers className="h-3.5 w-3.5" />
          <span>{area.displayName}</span>
        </div>
      )}
      {/* Chart-focus (hover/highlight sync) is provided page-level by the host (DashboardClient /
          DeviceLayout) so the header's TemporalNavigator shares it too — see HeaderTemporalNav. */}
      <div className="space-y-4">{body}</div>
    </section>
  );
}
