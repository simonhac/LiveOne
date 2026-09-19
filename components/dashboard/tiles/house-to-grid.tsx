"use client";

import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import Tile from "@/components/Tile";
import Value from "@/components/ui/value";
import TrendRow from "@/components/ui/trend-row";
import DirectionChip, {
  FLOW_DOUBLE_W,
  flowDirection,
} from "@/components/ui/direction-chip";
import { subjectOf, useAreaDatum } from "@/components/dashboard/cards/shared";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import {
  reduceLoadProvenance,
  reduceSourceProvenance,
} from "@/lib/energy-flow-matrix";
import { formatDollars, formatKwh, pricedTotal } from "@/lib/provenance-format";
import { siteDataQuery } from "@/lib/queries";
import { IDLE_CHROME, ROLE_CHROME } from "@/lib/role-chrome";
import type { TilePlugin, TileRenderProps } from "./types";
import { formatPowerValue, getPointValue, getMeasurementTime } from "./shared";

/**
 * One period row: the Trends-card shape — chip, label, energy in the grid's colour, and what it cost
 * or earned as the caption beside it.
 */
function PeriodRow({
  direction,
  label,
  energyKwh,
  cents,
}: {
  direction: "up" | "down";
  label: string;
  energyKwh: number;
  cents: number | null;
}) {
  return (
    <TrendRow
      chip={
        <DirectionChip direction={direction} color={ROLE_CHROME.grid.rgb} />
      }
      label={label}
      value={<Value value={formatKwh(energyKwh)} unit="kWh" />}
      valueColor={ROLE_CHROME.grid.value}
      // "—" = no export tariff / no grid price / not fully priced — never a misleading $0.
      caption={cents != null ? formatDollars(cents) : "—"}
    />
  );
}

/** Grid import/export tile — live flow as the hero, the period's import and export under it. */
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

  // The grid's IDENTITY colour (magenta, matching `CHART_COLORS.grid`) whenever there is flow; grey
  // inside the dead band. Direction rides on the chip — positive grid power is IMPORT, energy
  // arriving, so "down" — never on the colour. See lib/role-chrome.ts.
  const direction = flowDirection(gridPower, false);
  const idle = direction === "idle";

  return (
    <Tile
      title="Grid"
      icon={<Zap />}
      tone={ROLE_CHROME.grid.value}
      label={idle ? "Now" : direction === "down" ? "Importing" : "Exporting"}
      value={idle ? "Idle" : formatPowerValue(Math.abs(gridPower))}
      unit={idle ? undefined : "kW"}
      valueColor={idle ? IDLE_CHROME.value : ROLE_CHROME.grid.value}
      accessory={
        <DirectionChip
          direction={direction}
          color={ROLE_CHROME.grid.rgb}
          double={Math.abs(gridPower) > FLOW_DOUBLE_W}
          label={
            idle ? "Idle" : direction === "down" ? "Importing" : "Exporting"
          }
        />
      }
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={
        getMeasurementTime(latest, "bidi.grid/power") || undefined
      }
      extra={
        imported || exported ? (
          <div className="mt-auto space-y-2">
            {imported && (
              <PeriodRow
                direction="down"
                label="Imported"
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
                direction="up"
                label="Exported"
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
