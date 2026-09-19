"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  dayOffsetOf,
  subjectOf,
  useAreaDatum,
} from "@/components/dashboard/cards/shared";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { bucketBars, sumSeries, type TileBar } from "@/lib/charts/tile-bars";
import { siteDataQuery } from "@/lib/queries";
import type { ProcessedSiteData } from "@/lib/site-data-processor";

/**
 * The bars under the Solar and Load tiles, over the DASHBOARD's selected period.
 *
 * NO request of its own: it reads the same `siteDataQuery` the site charts and the Grid tile read,
 * which React Query dedupes on an identical key — so a section that draws charts pays nothing, and
 * the bars always agree with the stacked chart beside them (same series, same window). Disabled
 * without a host `systemId` (the prop-driven card gallery), where it returns no bars.
 *
 * `pick` chooses and sums the series; it must be stable (module-level), since it keys the memo.
 */
export function useSiteBars(
  systemId: number | undefined,
  pick: (site: ProcessedSiteData) => {
    timestamps: Date[];
    values: (number | null)[];
  } | null,
): TileBar[] {
  const { datum, paused } = useAreaDatum(systemId ?? 0, {
    enabled: systemId != null,
  });
  const subject = subjectOf(datum);
  const tz = subject?.timezoneOffsetMin ?? 600;
  const dayOffset = dayOffsetOf(datum) ?? tz;
  const { period, start, end } = useTemporalRange({ timezoneOffsetMin: tz });
  const { data: site } = useQuery(
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

  return useMemo(() => {
    if (!site) return [];
    const series = pick(site);
    if (!series) return [];
    // Hours are wall-clock (timezone); days are the subject's canonical day buckets, which can
    // differ from the timezone for a re-bucketed area — see `dayOffsetOf`.
    return bucketBars(
      series.timestamps,
      series.values,
      period,
      period === "D" ? tz : dayOffset,
    );
  }, [site, pick, period, tz, dayOffset]);
}

/** Solar generation: every generation-side series that maps to a `source.solar*` flow node. */
export function pickSolar(site: ProcessedSiteData) {
  const gen = site.generation;
  if (!gen) return null;
  const solar = gen.series.filter(
    (s) => s.seriesType !== "soc" && s.flowPath?.startsWith("source.solar"),
  );
  if (solar.length === 0) return null;
  return {
    timestamps: gen.timestamps,
    values: sumSeries(solar.map((s) => s.data)),
  };
}

/**
 * House consumption: the load-side stack MINUS the two legs that are not the house — battery charge
 * (`load.battery`) and grid export (`load.grid`). What remains is exactly the stacked chart's
 * household bands (sub-meters + rest-of-house).
 */
export function pickLoad(site: ProcessedSiteData) {
  const load = site.load;
  if (!load) return null;
  const house = load.series.filter(
    (s) =>
      s.seriesType !== "soc" &&
      s.flowPath !== "load.battery" &&
      s.flowPath !== "load.grid",
  );
  if (house.length === 0) return null;
  return {
    timestamps: load.timestamps,
    values: sumSeries(house.map((s) => s.data)),
  };
}
