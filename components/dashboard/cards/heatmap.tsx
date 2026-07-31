"use client";

/**
 * The `heatmap` card — 30 days × 48 half-hour slots of any one of a device's points, as a card.
 *
 * The card form of `/device/{id}/heatmap`. Both mount the SAME `HeatmapPanel`
 * (components/heatmap/HeatmapPanel.tsx, extracted at stage 3), so there is one selector, one points
 * fetch and one `HeatmapChart` between them; this file only supplies the v4 bindings and turns off
 * the two page-only affordances.
 *
 * A CARD plugin, not a tile: it is document-driven (it reads `node.config` and fetches both the
 * device's point list and its own 30-day window), where a tile is data-driven off the host's
 * `/api/data` `latest` map and must answer `isAvailable` from it. A `latest` snapshot is a set of
 * instantaneous values — there is nothing in it that could gate 30 days of history — and filing this
 * under the tile arm would make the host fetch `/api/data` for it and then hand it a payload it does
 * not read.
 *
 * DEBUG AND KEYBOARD NAV ARE OFF, and not merely for tidiness. The debug table prints the fetch
 * range in two timezones — a diagnostic for the standalone page, noise on a dashboard. Keyboard nav
 * binds ←/→/↑/↓ on `window`: harmless when the page IS the heatmap, but on a dashboard it would
 * hijack arrow keys for whichever heatmap card mounted last, and two cards would fight over them.
 *
 * `pending: "self"`. The panel already owns a loading state for the points fetch it cannot avoid, so
 * letting the host draw `ChartSkeleton` first would show the user two different placeholders in
 * sequence for one card. Instead the card mounts immediately and shows one, consistent, card-sized
 * block from mount until the chart appears.
 *
 * No `collapseKey`: this is a standalone card, never folded into the section's SiteChartsGroup.
 */
import { useMemo } from "react";
import HeatmapPanel from "@/components/heatmap/HeatmapPanel";
import { resolveHeatmapConfig } from "@/lib/dashboard/heatmap-card";
import type {
  HeatmapCardConfig,
  HeatmapPaletteName,
} from "@/lib/dashboard/card-types";
import type { HeatmapPaletteKey } from "@/lib/heatmap-colors";
import type { CardPlugin, CardRenderProps } from "./types";
import { ChartSkeleton, subjectOf, useAreaDatum } from "./shared";

/**
 * 🛑 The keep-in-sync gate for `HEATMAP_PALETTE_KEYS` (lib/dashboard/card-types.ts), which restates
 * the palette vocabulary as a zod-usable tuple because the server-safe config module must not import
 * the ESM-only `d3-scale-chromatic` behind `HEATMAP_PALETTES`. This assertion is mutual — adding,
 * removing OR renaming a palette in lib/heatmap-colors.ts without updating that tuple is a build
 * error HERE, in a client module where the type import is erased at runtime.
 */
type Mutually<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _paletteVocabularyInSync: Mutually<HeatmapPaletteName, HeatmapPaletteKey> =
  true;
void _paletteVocabularyInSync;

function ConfigNotice() {
  return (
    <div className="rounded-lg border border-gray-700/70 bg-gray-900/30 px-4 py-3 text-sm text-gray-400">
      This heatmap card is misconfigured.
    </div>
  );
}

function AreaHeatmap({ handle, deviceSystemId, node }: CardRenderProps) {
  const config = useMemo(() => resolveHeatmapConfig(node.config), [node.config]);
  // A bound member device wins over the area handle — the same rule `device-metrics` and
  // `generator-runs` use, and the one the catalog's `scope: "device"` implies. A heatmap is of ONE
  // device's point set, so when the node (or an ancestor) pins a device, that is the subject.
  const systemId = deviceSystemId ?? handle;

  if (!config) return <ConfigNotice />;
  // `pending: "self"` means the handle may still be unresolved on the first paint (the areas
  // resolve a tick after mount). The subject query lives in the child rather than here precisely so
  // that this branch does not have to invent a systemId to keep the hook order stable — a
  // `useAreaDatum(0)` placeholder would fire a real `/api/data?systemId=0` on every dashboard load.
  if (systemId == null) return <ChartSkeleton />;
  return <ResolvedHeatmap systemId={systemId} config={config} />;
}

function ResolvedHeatmap({
  systemId,
  config,
}: {
  systemId: number;
  config: HeatmapCardConfig;
}) {
  const { datum } = useAreaDatum(systemId);
  // The IANA zone, not the offset: `HeatmapChart` buckets into local half-hours across a 30-day
  // window, which straddles DST wherever the subject observes it.
  const timezone = subjectOf(datum)?.displayTimezone;
  if (!timezone) return <ChartSkeleton />;

  return (
    <HeatmapPanel
      systemId={systemId}
      timezone={timezone}
      pinnedSeries={config.series}
      pinnedPalette={config.palette}
      variant="card"
    />
  );
}

export const heatmapPlugin: CardPlugin = {
  kind: "card",
  type: "heatmap",
  pending: "self",
  Render: AreaHeatmap,
};
