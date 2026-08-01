"use client";

import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import Tile from "@/components/Tile";
import Value from "@/components/ui/value";
import { subjectOf, useAreaDatum } from "@/components/dashboard/cards/shared";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import {
  reduceLoadProvenance,
  reduceSourceProvenance,
} from "@/lib/energy-flow-matrix";
import { formatDollars, formatKwh } from "@/lib/provenance-format";
import { siteDataQuery } from "@/lib/queries";
import { IDLE_CHROME, ROLE_CHROME } from "@/lib/role-chrome";
import type { TilePlugin, TileRenderProps } from "./types";
import {
  formatPowerValue,
  getFlowChevron,
  getPointValue,
  getMeasurementTime,
} from "./shared";

/**
 * A money total is shown ONLY when essentially all of the period's energy carried a known price.
 * The provenance reducers sum whatever is priced and report the covered kWh alongside, so a
 * partially-priced period otherwise renders a confident-looking total that is silently too low —
 * which is exactly what a half-finished `flow_attr_1d` backfill produces (a 30-day window with one
 * day of `revenue_c` read "$0.08" for 54.8 kWh exported). Below full coverage we say "—" instead.
 */
const COVERAGE_MIN = 0.995;
function pricedTotal(
  cents: number | null,
  knownKwh: number,
  energyKwh: number,
): number | null {
  if (cents == null) return null;
  return knownKwh >= energyKwh * COVERAGE_MIN ? cents : null;
}

/** One sub-line: label, energy, money — the three grid cells that make both rows line up. */
function PeriodRow({
  short,
  long,
  energyKwh,
  cents,
}: {
  short: string;
  long: string;
  energyKwh: number;
  cents: number | null;
}) {
  return (
    <>
      <span>
        <span className="md:hidden">{short}</span>
        <span className="hidden md:inline">{long}</span>
      </span>
      <span className="text-right">
        <Value value={formatKwh(energyKwh)} unit="kWh" />
      </span>
      {/* "—" = no export tariff / no grid price / not fully priced — never a misleading $0. */}
      <span className="text-right">
        {cents != null ? formatDollars(cents) : "—"}
      </span>
    </>
  );
}

/** Grid import/export tile — import (red) / export (green) / idle under 100 W. */
function HouseToGridTile({
  latest,
  systemId,
  staleThresholdSeconds,
}: TileRenderProps) {
  const gridPower = getPointValue(latest, "bidi.grid/power") || 0;

  // Period totals under the live hero: the energy imported/exported and what it cost/earned over the
  // DASHBOARD's selected period, so this tile follows the shared temporal navigator like the charts.
  // It reads the SAME attributed-flow payload the Sankey uses (`siteDataQuery`), which React Query
  // dedupes on an identical key — no extra request on a section that already draws charts.
  const { datum, paused } = useAreaDatum(systemId ?? 0, {
    enabled: systemId != null,
  });
  const tz = subjectOf(datum)?.timezoneOffsetMin ?? 600;
  const { period, start, end } = useTemporalRange({ timezoneOffsetMin: tz });
  const { data: siteData } = useQuery(
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
  // `source.grid` is import (what we bought → costC); `load.grid` is export (what we sold → revenueC).
  // Export's `costC` is deliberately NOT used: it is the cost BASIS of the exported energy (~0 for
  // solar), not the feed-in income.
  const imported = flow ? reduceSourceProvenance(flow, "source.grid") : null;
  const exported = flow ? reduceLoadProvenance(flow, "load.grid") : null;

  // Chrome is the grid's IDENTITY colour (magenta, matching `CHART_COLORS.grid`) whenever there is
  // flow. It used to be red for import / green for export, which collided with `ev` red-600 and the
  // red crosshair, and made green mean "exporting" here while it meant "charging" on the Battery
  // tile. Direction rides on the chevron and the Importing/Exporting label. See lib/role-chrome.ts.
  const chrome = Math.abs(gridPower) >= 100 ? ROLE_CHROME.grid : IDLE_CHROME;

  return (
    <Tile
      title="Grid"
      value={
        Math.abs(gridPower) < 100
          ? "Idle"
          : formatPowerValue(Math.abs(gridPower))
      }
      unit={Math.abs(gridPower) < 100 ? undefined : "kW"}
      icon={
        <span className="inline-flex items-center h-6 flex-row-reverse md:flex-row">
          {getFlowChevron(
            gridPower,
            gridPower < 0, // negative = exporting = into grid
            chrome.icon,
          )}
          <Zap className="w-6 h-6" />
        </span>
      }
      iconColor={chrome.icon}
      bgColor={chrome.tint}
      borderColor={chrome.border}
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={
        getMeasurementTime(latest, "bidi.grid/power") || undefined
      }
      extraInfo={
        gridPower >= 100
          ? "Importing"
          : gridPower <= -100
            ? "Exporting"
            : undefined
      }
      extra={
        imported || exported ? (
          // Three columns, both numeric ones right-aligned, so the kWh and $ line up across rows.
          <div className="grid grid-cols-[auto_1fr_auto] gap-x-1.5 text-[10px] md:text-xs text-gray-400 tabular-nums">
            {imported && (
              <PeriodRow
                short="Imp"
                long="Imported"
                energyKwh={imported.energyKwh}
                // `costC` is a plain number that stays 0 when nothing was priced — `costKnownKwh` is
                // the flag that separates "no grid price" from "genuinely cost $0".
                cents={pricedTotal(
                  imported.costKnownKwh > 0 ? imported.costC : null,
                  imported.costKnownKwh,
                  imported.energyKwh,
                )}
              />
            )}
            {exported && (
              <PeriodRow
                short="Exp"
                long="Exported"
                energyKwh={exported.energyKwh}
                cents={pricedTotal(
                  exported.revenueC,
                  exported.revenueKnownKwh,
                  exported.energyKwh,
                )}
              />
            )}
          </div>
        ) : undefined
      }
    />
  );
}

export const houseToGridTile: TilePlugin = {
  kind: "tile",
  type: "house-to-grid",
  isAvailable: ({ latest, showGrid }) =>
    showGrid && getPointValue(latest, "bidi.grid/power") !== null,
  Render: HouseToGridTile,
};
