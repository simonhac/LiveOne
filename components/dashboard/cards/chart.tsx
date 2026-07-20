"use client";

/**
 * The `chart` card. The lines variant renders standalone here and mounts immediately (its history
 * fetch doesn't need the handle's `system` to have landed yet — see the tz note below); the
 * stacked-areas variant never renders standalone: `collapseKey` folds it into the section's
 * SiteChartsGroup (chart:load / chart:generation).
 */
import LinesChartCard from "@/components/LinesChartCard";
import type { CardPlugin, CardRenderProps } from "./types";
import { maxPowerHintFromSystemInfo, useAreaDatum } from "./shared";

function AreaLinesChart({ handle }: CardRenderProps) {
  const systemId = handle!;
  const { data, datum } = useAreaDatum(systemId);
  // `timezoneOffsetMin` only drives LinesChartCard's refetch-cadence scheduling and future
  // older/newer/setPeriod URL writes — the current window (decoded from the URL) and the history
  // fetch itself (server-resolved for `last=`; `encodeHistoryWindow` needs no tz for an explicit
  // window either) don't depend on it. So mount immediately with a harmless placeholder instead of
  // blocking the whole chart on `/api/data` landing first; the real value swaps in once `datum`
  // resolves.
  const tz = datum?.system?.timezoneOffsetMin ?? 0;
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
