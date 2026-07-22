"use client";

import { Leaf } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Tile from "@/components/Tile";
import type { LatestPointValues } from "@/lib/types/api";
import type { TilePlugin, TileRenderProps } from "./types";
import { getPointValue, getMeasurementTime } from "./shared";
import { useAreaDatum } from "@/components/dashboard/cards/shared";
import { siteDataQuery } from "@/lib/queries";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { reduceRenewablesMetrics } from "@/lib/renewables/summary";

/**
 * The "Renewables" tile — three labelled percentages over the DASHBOARD's currently-selected period
 * (1D/7D/30D), so it follows the shared temporal navigator like the charts (NOT a fixed window, and NOT
 * an instantaneous value):
 *   1. Renewable autarky              — consumption covered by OUR OWN renewable generation.
 *   2. Own-renewable self-consumption — of the renewable WE generated, the share consumed on site.
 *   3. Renewable share of consumption — own + grid renewables.
 * Metrics 1-2 draw on the joint `self_renewable_kwh` leg; metric 3 on the existing `renewable_kwh`.
 *
 * NO dedicated route: it reads the SAME period-scoped attributed-flow payload the Sankey uses
 * (`siteDataQuery` → `/api/history?include=sankey` → `attributedFlow`, deduped with the charts) and
 * reduces it client-side via `reduceRenewablesMetrics`. Sub-daily (1D/7D) is computed live, so
 * "today so far" is real; 30D reads the daily rollup.
 */

const fmtPct = (x: number | null | undefined): string =>
  x == null ? "—" : `${Math.round(x * 100)}%`;

/** The headline value only — no "%": the Tile renders the (small) "%" via its `unit` prop, so a "%"
 *  here too would double it up ("21%%"). The `extra` MetricRows keep `fmtPct` (single, inline "%"). */
const fmtPctValue = (x: number | null | undefined): string =>
  x == null ? "—" : `${Math.round(x * 100)}`;

const AUTARKY_TIP =
  "Renewable autarky — the share of your consumption covered by your OWN renewable generation " +
  "(solar directly, or via the battery at its self-renewable blend). Grid imports and any backup " +
  "generator are self-origin only when renewable, so grid mix and generator energy are excluded here.";
const SELF_CONSUMPTION_TIP =
  "Own-renewable self-consumption — of the renewable energy you generated, the fraction consumed on " +
  "site rather than exported. Battery round-trip losses reduce it. “—” when you generated no own " +
  "renewable in the period.";
const SHARE_TIP =
  "Renewable share of consumption — your own renewables plus the renewable fraction of the grid you " +
  "imported.";

function MetricRow({
  label,
  value,
  tip,
}: {
  label: string;
  value: string;
  tip: string;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-2 cursor-help"
      title={tip}
    >
      <span className="text-gray-400 truncate">{label}</span>
      <span className="text-gray-200 font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function RenewablesTile({
  latest,
  systemId,
  staleThresholdSeconds,
}: TileRenderProps) {
  const { datum, paused } = useAreaDatum(systemId ?? 0);
  const tz = datum?.system?.timezoneOffsetMin ?? 600;

  // Freshness of the site's live feed (like the sibling tiles) — without a measurementTime the Tile
  // treats the tile as permanently stale and paints the diagonal "stale" hatch + dims it.
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
  const m = summary?.metrics;
  const loading = !isError && !siteData;

  return (
    <Tile
      title="Renewables"
      value={loading ? "…" : fmtPctValue(m?.renewableAutarky)}
      unit={loading || m?.renewableAutarky == null ? undefined : "%"}
      icon={<Leaf className="w-6 h-6" />}
      iconColor="text-green-400"
      bgColor="bg-green-900/20"
      borderColor="border-green-700"
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={measurementTime}
      extraInfo={`over ${period}`}
      extra={
        <div className="text-xs space-y-0.5">
          <MetricRow
            label="Autarky"
            value={loading ? "…" : fmtPct(m?.renewableAutarky)}
            tip={AUTARKY_TIP}
          />
          <MetricRow
            label="Self-use"
            value={loading ? "…" : fmtPct(m?.ownRenewableSelfConsumption)}
            tip={SELF_CONSUMPTION_TIP}
          />
          <MetricRow
            label="Renewable"
            value={loading ? "…" : fmtPct(m?.renewableShare)}
            tip={SHARE_TIP}
          />
        </div>
      }
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
  view: "renewables",
  isAvailable: ({ latest, showGrid }) => renewablesAvailable(latest, showGrid),
  Render: RenewablesTile,
};
