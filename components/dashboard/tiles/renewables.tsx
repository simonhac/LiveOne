"use client";

import { useQuery } from "@tanstack/react-query";
import HomeEnergyCard from "@/components/HomeEnergyCard";
import type { LatestPointValues } from "@/lib/types/api";
import type { TilePlugin, TileRenderProps } from "./types";
import { getPointValue, getMeasurementTime } from "./shared";
import { subjectOf, useAreaDatum } from "@/components/dashboard/cards/shared";
import { siteDataQuery } from "@/lib/queries";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { PERIOD_LABEL } from "@/lib/charts/temporal";
import { reduceRenewablesMetrics } from "@/lib/renewables/summary";

/**
 * The "Home Energy" card (tile view `renewables`) — everything the site CONSUMED over the DASHBOARD's
 * currently-selected period (D/W/M/Y), so it follows the shared temporal navigator like the charts (NOT
 * a fixed window, and NOT an instantaneous value): the energy, its blended rate and emissions intensity,
 * its renewable share, the absolute cost/carbon, and then the two own-generation ratios:
 *   1. Renewable autarky              — consumption covered by OUR OWN renewable generation.
 *   2. Own-renewable self-consumption — of the renewable WE generated, the share consumed on site.
 * Metrics 1-2 draw on the joint `self_renewable_kwh` leg.
 *
 * NO dedicated route: it reads the SAME period-scoped attributed-flow payload the Sankey uses
 * (`siteDataQuery` → `/api/history?include=sankey` → `attributedFlow`, deduped with the charts) and
 * reduces it client-side via `reduceRenewablesMetrics`. Sub-daily (D/W) is computed live, so
 * "today so far" is real; M/Y read the daily rollup.
 *
 * It renders a full card ({@link HomeEnergyCard}) rather than a `Tile`; it stays a tile VIEW only so the
 * persisted dashboard docs — where it already sits alone in its own row, hence full width — need no
 * rewrite.
 */

function RenewablesTile({
  latest,
  systemId,
  staleThresholdSeconds,
}: TileRenderProps) {
  const { datum, paused } = useAreaDatum(systemId ?? 0);
  const tz = subjectOf(datum)?.timezoneOffsetMin ?? 600;

  // Freshness of the site's live feed (like the sibling tiles) — without a measurementTime the card
  // treats itself as permanently stale and paints the diagonal "stale" hatch + dims it.
  const measurementTime =
    getMeasurementTime(latest, "load/power") ??
    getMeasurementTime(latest, "bidi.grid/power") ??
    getMeasurementTime(latest, "source.solar/power") ??
    undefined;

  // Follow the shared temporal navigator (URL state) — the same 1D/7D/30D + window the charts use.
  const { period, start, end } = useTemporalRange({ timezoneOffsetMin: tz });

  const { data: siteData, isError } = useQuery(
    siteDataQuery({
      systemId: systemId ?? 0,
      period,
      start,
      end,
      timezoneOffsetMin: tz,
      paused,
      enabled: systemId != null,
    }),
  );

  const flow = siteData?.attributedFlow;
  const summary = flow ? reduceRenewablesMetrics(flow) : null;

  return (
    <HomeEnergyCard
      summary={summary}
      periodLabel={PERIOD_LABEL[period]}
      measurementTime={measurementTime}
      staleThresholdSeconds={staleThresholdSeconds}
      loading={!isError && !siteData}
    />
  );
}

/** Solar generation present, OR a grid connection (grid-only sites still get the renewable-share
 *  metric — metrics 1 & 2 then correctly read 0 / — rather than being hidden). */
function renewablesAvailable(latest: LatestPointValues, showGrid: boolean) {
  const hasSolar =
    getPointValue(latest, "source.solar/power") !== null ||
    getPointValue(latest, "source.solar.local/power") !== null ||
    getPointValue(latest, "source.solar.remote/power") !== null;
  return hasSolar || showGrid;
}

export const renewablesTile: TilePlugin = {
  kind: "tile",
  type: "renewables",
  isAvailable: ({ latest, showGrid }) => renewablesAvailable(latest, showGrid),
  Render: RenewablesTile,
};
