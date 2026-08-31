"use client";

/**
 * The `daily-stripe` card — any point as a day-per-row gradient stripe timeline.
 *
 * The generic form of the HWS lab timeline (`/labs/kinkora-hws`): with
 * `primary = load.hws/temperature` + `state = load.hws/power` it reproduces that page's chart, and
 * with no `state` it collapses to a single full-height gradient row per day for a plain point
 * (`DailyStripes` already implements both layouts — `stateH = 0` when `state` is absent).
 *
 * A CARD plugin, not a tile: it is document-driven (it reads `node.config` and fetches its own
 * window from `/api/history`), where a tile is data-driven off the host's `/api/data` `latest` map
 * and must answer `isAvailable` from it. There is nothing in a `latest` snapshot that could gate 7
 * days of history, and filing it under the tile arm would make the host fetch `/api/data` for it and
 * then hand it a payload it does not use.
 *
 * Deliberately NOT unified with `app/labs/kinkora-hws/page.tsx`. The lab carries the HWS model's
 * last value forward across gaps; the generic card does not (a gap shows the background), so the two
 * differ exactly where the lab is modelling rather than reporting. Accepted duplication.
 *
 * No `collapseKey`: this is a standalone card, never folded into the section's SiteChartsGroup.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import DailyStripes from "@/components/dashboard/DailyStripes";
import Panel from "@/components/ui/panel";
import { historyQuery } from "@/lib/queries/history";
import { encodeHistoryWindow } from "@/lib/charts/history-window";
import {
  dailyStripeFootprint,
  dailyStripeWindow,
  resolveDailyStripeConfig,
  resolveDomain,
  resolvePalette,
  seriesTermFor,
  seriesToMap,
  STRIPE_SLOTS_PER_DAY,
  STRIPE_SLOT_MS,
} from "@/lib/dashboard/daily-stripe";
import type { CardPlugin, CardRenderProps } from "./types";
import { CardSkeleton, subjectOf, useAreaDatum } from "./shared";

function ConfigNotice() {
  return (
    <Panel className="px-4 py-3 text-sm text-gray-400" padded={false}>
      This daily-stripe card is misconfigured.
    </Panel>
  );
}

function AreaDailyStripes({ node, handle, deviceSystemId }: CardRenderProps) {
  // A bound member device wins over the area handle — the same rule `device-metrics` and
  // the `runs` card's use. A logical path is a property of a device's point set, so when the node (or
  // an ancestor) pins a device, that device is what the path must resolve against.
  const systemId = deviceSystemId ?? handle!;
  const { datum, paused } = useAreaDatum(systemId);
  const tz = subjectOf(datum)?.timezoneOffsetMin;

  const config = useMemo(
    () => resolveDailyStripeConfig(node.config),
    [node.config],
  );

  const primaryTerm = config ? seriesTermFor(config.primary) : "";
  const stateTerm = config?.state ? seriesTermFor(config.state) : null;

  // The window is recomputed each render but only MOVES on a 5m boundary, so the query key is
  // stable between boundaries and the card refreshes on the same cadence as the data.
  const win = dailyStripeWindow(Date.now(), tz ?? 0, config?.days ?? 7);
  const { startTime, endTime } = encodeHistoryWindow(
    new Date(win.firstDayMidnightMs).toISOString(),
    new Date(win.endMs).toISOString(),
    "5m",
  );

  const { data, isLoading } = useQuery(
    historyQuery({
      systemId,
      interval: "5m",
      startTime,
      endTime,
      series: [primaryTerm, stateTerm].filter(Boolean).join(","),
      timezoneOffsetMin: tz,
      paused,
      enabled: config != null && tz != null && !paused,
    }),
  );

  const values = useMemo(
    () => seriesToMap(data, primaryTerm),
    [data, primaryTerm],
  );
  const state = useMemo(
    () => (stateTerm ? seriesToMap(data, stateTerm) : undefined),
    [data, stateTerm],
  );

  if (!config) return <ConfigNotice />;
  // Exactly the height the stripe will occupy: it is `config.days` rows tall whatever the history
  // turns out to contain, so this placeholder is the same size as its replacement.
  if (tz == null || isLoading)
    return <CardSkeleton height={dailyStripeFootprint(config)} />;

  return (
    <DailyStripes
      values={values}
      state={state}
      tz={tz}
      firstDayMidnightMs={win.firstDayMidnightMs}
      dayCount={win.dayCount}
      slotMs={STRIPE_SLOT_MS}
      slotsPerDay={STRIPE_SLOTS_PER_DAY}
      domain={resolveDomain(values, config.color?.min, config.color?.max)}
      palette={resolvePalette(config.color)}
      onThreshold={config.state?.onThreshold ?? 0}
      unit={config.unit}
      label={config.label}
    />
  );
}

export const dailyStripePlugin: CardPlugin = {
  kind: "card",
  type: "daily-stripe",
  footprint: (node) =>
    dailyStripeFootprint(resolveDailyStripeConfig(node.config)),
  Render: AreaDailyStripes,
};
