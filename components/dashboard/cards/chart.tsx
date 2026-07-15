"use client";

/**
 * The `chart` card. The lines variant renders standalone here (self-fetches the handle's `system`
 * for its timezone — the temporal navigator needs it to format the range label + encode historical
 * URLs). The stacked-areas variant never renders standalone: `collapseKey` folds it into the
 * section's SiteChartsGroup (chart:load / chart:generation).
 */
import LinesChartCard from "@/components/LinesChartCard";
import type { CardPlugin, CardRenderProps } from "./types";
import {
  ChartSkeleton,
  maxPowerHintFromSystemInfo,
  useAreaDatum,
} from "./shared";

function AreaLinesChart({ handle }: CardRenderProps) {
  const systemId = handle!;
  const { data, datum } = useAreaDatum(systemId);
  const tz = datum?.system?.timezoneOffsetMin;
  if (tz == null) {
    return <ChartSkeleton />;
  }
  const systemInfo = (
    data as { systemInfo?: { solarSize?: string; ratings?: string } } | null
  )?.systemInfo;
  // Configured nameplate wins; fall back to scraping the free-text solarSize/ratings.
  const maxPowerHint =
    datum?.system?.config?.nameplateKw ??
    maxPowerHintFromSystemInfo(systemInfo);
  return (
    <LinesChartCard
      systemId={systemId}
      className="h-full min-h-[360px]"
      timezoneOffsetMin={tz}
      maxPowerHint={maxPowerHint}
    />
  );
}

export const chartPlugin: CardPlugin = {
  type: "chart",
  collapseKey: (card) =>
    card.chart?.variant === "stacked-areas"
      ? card.chart.split === "generation"
        ? "chart:generation"
        : "chart:load"
      : null,
  Render: AreaLinesChart,
};
