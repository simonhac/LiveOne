"use client";

import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import Panel from "@/components/ui/panel";
import HeatmapPanel, {
  type HeatmapSelection,
} from "@/components/heatmap/HeatmapPanel";
import { HEATMAP_PALETTES, HeatmapPaletteKey } from "@/lib/heatmap-colors";

/**
 * The standalone `/device/{id}/heatmap` page: chrome + the `?point=`/`?palette=` URL glue around
 * `HeatmapPanel`, which owns the selectors, the points fetch and the chart.
 */

interface AvailableDevice {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface HeatmapClientProps {
  systemIdentifier: string; // For display/routing purposes (can be "1586" or "simon/kinkora")
  device: {
    id: number;
    displayName: string;
    displayTimezone: string;
    /**
     * A device has no `day_offset_min` of its own — that column lives on `areas` — so its fixed
     * offset IS its tz offset. Same fallback `dayOffsetOf` makes for the device leg on a dashboard.
     */
    timezoneOffsetMin: number;
  };
  userId: string;
  isAdmin: boolean;
  availableDevices: AvailableDevice[];
}

export default function HeatmapClient({ device }: HeatmapClientProps) {
  const searchParams = useSearchParams();

  // Read the URL parameters ONCE (lazy state init) — as before, later `searchParams` changes are
  // ignored, and the panel only applies these on its own mount.
  const [initial] = useState(() => {
    const point = searchParams.get("point") ?? undefined;
    const paletteParam = searchParams.get("palette");
    const palette =
      paletteParam && paletteParam in HEATMAP_PALETTES
        ? (paletteParam as HeatmapPaletteKey)
        : undefined;
    return { point, palette };
  });

  // The panel reports the FULL resulting selection on every user change, so both params can be
  // rewritten together (as the pre-extraction `updateUrlParams` did) with no mirrored state here.
  const handleSelectionChange = useCallback((next: HeatmapSelection) => {
    const parts: string[] = [];
    if (next.series) {
      parts.push(`point=${next.series}`);
    }
    parts.push(`palette=${next.palette}`);
    // Use window.history instead of router to avoid Next.js navigation flash
    const newUrl = `${window.location.pathname}?${parts.join("&")}`;
    window.history.replaceState(null, "", newUrl);
  }, []);

  // The panel draws no frame of its own (chart-style.md: one frame per nesting level, owned by the
  // host). On a dashboard the v4 section is that host; here there is no section, so this page is.
  return (
    <Panel className="container mx-auto my-8">
      <HeatmapPanel
        systemId={device.id}
        timezone={device.displayTimezone}
        dayOffsetMin={device.timezoneOffsetMin}
        showDebug
        enableKeyboardNav
        initialSeries={initial.point}
        initialPalette={initial.palette}
        onSelectionChange={handleSelectionChange}
      />
    </Panel>
  );
}
