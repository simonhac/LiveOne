"use client";

import { Leaf } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDate } from "@internationalized/date";
import Tile from "@/components/Tile";
import type { LatestPointValues } from "@/lib/types/api";
import type { TilePlugin, TileRenderProps } from "./types";
import { getPointValue } from "./shared";
import { useAreaDatum } from "@/components/dashboard/cards/shared";
import {
  areaByHandleQuery,
  renewablesSummaryQuery,
} from "@/lib/queries/renewablesSummary";

/**
 * The "Renewables" tile — three labelled percentages over a trailing window:
 *   1. Renewable autarky              — consumption covered by OUR OWN renewable generation.
 *   2. Own-renewable self-consumption — of the renewable WE generated, the share consumed on site.
 *   3. Renewable share of consumption — own + grid renewables.
 * Metrics 1-2 draw on the joint `self_renewable_kwh` leg; metric 3 on the existing `renewable_kwh`.
 *
 * Data plumbing mirrors a self-fetching tile (hot-water): it self-fetches from an AREA-keyed route
 * (`/api/areas/[areaId]/renewables-summary`) but a tile only receives the numeric handle, so it first
 * resolves the area UUID via `/api/areas/by-handle/[handle]` (owner/admin/cron — a share-token-only
 * viewer therefore sees no tile; the summary route itself is share-token aware for when an areaId is
 * in hand). Window: the trailing 30 COMPLETED local days (the flow_attr rollup is per completed day).
 */

const fmtPct = (x: number | null | undefined): string =>
  x == null ? "—" : `${Math.round(x * 100)}%`;

const AUTARKY_TIP =
  "Renewable autarky — the share of your consumption covered by your OWN renewable generation " +
  "(solar directly, or via the battery at its self-renewable blend). Grid renewables are excluded.";
const SELF_CONSUMPTION_TIP =
  "Own-renewable self-consumption — of the renewable energy you generated, the fraction consumed on " +
  "site rather than exported. Battery round-trip losses reduce it. “—” when you generated no own " +
  "renewable in the period.";
const SHARE_TIP =
  "Renewable share of consumption — your own renewables plus the renewable fraction of the grid you " +
  "imported.";
const GENERATOR_NOTE =
  " Your generator's energy is self-origin but NOT renewable, so it is excluded from this metric.";

function trailingWindow(tzOffsetMin: number): { start: string; end: string } {
  // Last completed local day (yesterday in the area's tz) back 30 days — the rollup's grain.
  const nowLocal = new Date(Date.now() + tzOffsetMin * 60_000);
  const today = new CalendarDate(
    nowLocal.getUTCFullYear(),
    nowLocal.getUTCMonth() + 1,
    nowLocal.getUTCDate(),
  );
  const end = today.subtract({ days: 1 });
  const start = end.subtract({ days: 29 });
  return { start: start.toString(), end: end.toString() };
}

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

function RenewablesTile({ systemId, staleThresholdSeconds }: TileRenderProps) {
  const { datum } = useAreaDatum(systemId ?? 0);
  const tz = datum?.system?.timezoneOffsetMin;

  const { data: area } = useQuery(
    areaByHandleQuery(systemId ?? 0, systemId != null),
  );
  const areaId = area?.areaId;

  const win = tz != null ? trailingWindow(tz) : null;
  const { data: summary, isError } = useQuery(
    renewablesSummaryQuery({
      areaId: areaId ?? "",
      startDay: win?.start,
      endDay: win?.end,
      enabled: !!areaId && win != null,
    }),
  );

  const m = summary?.metrics;
  const loading = !isError && !summary;

  return (
    <Tile
      title="Renewables"
      value={loading ? "…" : fmtPct(m?.renewableAutarky)}
      unit={loading || m?.renewableAutarky == null ? undefined : "%"}
      icon={<Leaf className="w-6 h-6" />}
      iconColor="text-green-400"
      bgColor="bg-green-900/20"
      borderColor="border-green-700"
      staleThresholdSeconds={staleThresholdSeconds}
      extraInfo={
        summary?.hasGenerator ? "generator excluded from autarky" : undefined
      }
      extra={
        <div className="text-xs space-y-0.5">
          <MetricRow
            label="Autarky"
            value={loading ? "…" : fmtPct(m?.renewableAutarky)}
            tip={AUTARKY_TIP + (summary?.hasGenerator ? GENERATOR_NOTE : "")}
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
