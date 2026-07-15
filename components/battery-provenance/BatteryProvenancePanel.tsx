"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import PeriodSwitcher from "@/components/PeriodSwitcher";
import ProvenanceChart from "@/components/battery-provenance/ProvenanceChart";
import ProvenanceValueTable from "@/components/battery-provenance/ProvenanceValueTable";
import {
  ChartFocusProvider,
  nearestIndex,
  useChartFocus,
} from "@/lib/charts/ChartFocusContext";
import { getPeriodDuration } from "@/lib/charts/temporal";
import type { ChartTimeRange } from "@/lib/charts/scaffold";
import { fromUnixTimestamp } from "@/lib/date-utils";
import { provenanceDailyQuery } from "@/lib/queries";
import {
  PROVENANCE_CHARTS,
  RECAL_BAND_COLOR,
  type ProvenanceDailyResponse,
} from "@/lib/battery-provenance/field-registry";
import {
  formatYMDRange,
  historicalWindow,
  ymdToLocalDate,
  zonedDateTimeToYMD,
} from "@/lib/battery-provenance/panel-dates";

/** The panel's periods: the trailing year, with 30D as a month-zoom over the same daily data. */
const PANEL_PERIODS: readonly ChartTimeRange[] = ["30D", "1Y"];
const DEFAULT_PERIOD: ChartTimeRange = "1Y";

const DAY_MS = 24 * 60 * 60 * 1000;

interface BatteryProvenancePanelProps {
  /** The BATTERY area whose battery_provenance_daily rows to show (the helper's parent area). */
  areaId: string;
  timezoneOffsetMin: number;
}

function PanelInner({
  areaId,
  timezoneOffsetMin,
}: BatteryProvenancePanelProps) {
  // Local (non-URL) temporal state — deliberately NOT `useTemporalRange`/`TemporalNavigator`, which
  // share ONE set of `?period`/`start`/`end`/`offset` URL params across every instance on the page.
  // This panel's periods (30D/1Y) are disjoint from the app-wide default trio (1D/7D/30D); sharing
  // the URL would let this panel's "1Y" silently reset a co-located chart's period to its fallback
  // (and vice versa) the moment this card is ever placed alongside one. Self-contained state avoids
  // that by construction — the tradeoff is no shareable/bookmarkable link to a specific past year,
  // acceptable for a diagnostic panel.
  const [period, setPeriodRaw] = useState<ChartTimeRange>(DEFAULT_PERIOD);
  const [olderSteps, setOlderSteps] = useState(0); // 0 = live; N = N whole periods back
  const setPeriod = useCallback((p: ChartTimeRange) => {
    setPeriodRaw(p);
    setOlderSteps(0); // switching period while browsing history would compound mismatched offsets
  }, []);
  const older = useCallback(() => setOlderSteps((s) => s + 1), []);
  const newer = useCallback(() => setOlderSteps((s) => Math.max(0, s - 1)), []);

  const { focusedTime, setFocusedTime } = useChartFocus();

  // Historical windows request their exact day range; live mode (olderSteps===0) omits params and
  // lets the server default to the trailing period ending yesterday, area-local.
  const { startDay, endDay } = useMemo(() => {
    if (olderSteps === 0) return { startDay: undefined, endDay: undefined };
    const dayCount = Math.round(getPeriodDuration(period) / DAY_MS);
    const today = zonedDateTimeToYMD(
      fromUnixTimestamp(Date.now() / 1000, timezoneOffsetMin),
    );
    const { startDay: start, endDay: end } = historicalWindow(
      today,
      dayCount,
      olderSteps,
    );
    return { startDay: start, endDay: end };
  }, [olderSteps, period, timezoneOffsetMin]);

  const {
    data: resp,
    isPending,
    isFetching,
    isError,
  } = useQuery(provenanceDailyQuery({ areaId, startDay, endDay }));

  // Window the raw payload to the period, precompute every series' value array once, and build
  // the recal band annotations (repo convention: transform in a useMemo, not in `select`).
  const view = useMemo(() => {
    if (!resp) return null;
    const dayCount = Math.round(getPeriodDuration(period) / DAY_MS);
    const from = Math.max(0, resp.days.length - dayCount);
    const slice = <T,>(arr: T[]): T[] => arr.slice(from);

    const days = slice(resp.days);
    const fields = Object.fromEntries(
      Object.entries(resp.fields).map(([k, arr]) => [k, slice(arr)]),
    ) as ProvenanceDailyResponse["fields"];
    const windowed: ProvenanceDailyResponse = {
      ...resp,
      days,
      fields,
      rowMeta: {
        firstIntervalEnd: slice(resp.rowMeta.firstIntervalEnd),
        version: slice(resp.rowMeta.version),
        updatedAt: slice(resp.rowMeta.updatedAt),
      },
    };

    const timestamps = days.map((d) => ymdToLocalDate(d, 12));
    const seriesValues: Record<string, (number | null)[]> = {};
    for (const chart of PROVENANCE_CHARTS) {
      for (const s of chart.series) {
        seriesValues[s.id] = days.map((_, i) => s.value(fields, i));
      }
    }

    const recalBands = days.flatMap((day, i) => {
      if (fields.recal[i] !== 1) return [];
      const dayStart = ymdToLocalDate(day).getTime();
      return [
        {
          type: "box",
          xMin: dayStart,
          xMax: dayStart + DAY_MS,
          backgroundColor: RECAL_BAND_COLOR,
          borderWidth: 0,
        },
      ];
    });

    const windowStart = days.length > 0 ? ymdToLocalDate(days[0]) : new Date();
    const windowEnd =
      days.length > 0
        ? new Date(ymdToLocalDate(days[days.length - 1]).getTime() + DAY_MS)
        : new Date();

    // Last day with ANY data — the table's resting ("Latest") index, so trailing not-yet-learned
    // days don't present a dash-only table. Field arrays hoisted once (not per iteration).
    const fieldArrays = Object.values(fields);
    let lastDataIndex: number | null = null;
    for (let i = days.length - 1; i >= 0; i--) {
      if (fieldArrays.some((arr) => arr[i] != null)) {
        lastDataIndex = i;
        break;
      }
    }

    return {
      windowed,
      timestamps,
      seriesValues,
      recalBands,
      windowStart,
      windowEnd,
      lastDataIndex,
    };
  }, [resp, period]);

  // Per-chart visible-series sets, seeded from the registry's hiddenByDefault flags.
  const [visibleByChart, setVisibleByChart] = useState<
    Record<string, Set<string>>
  >(() =>
    Object.fromEntries(
      PROVENANCE_CHARTS.map((c) => [
        c.id,
        new Set(c.series.filter((s) => !s.hiddenByDefault).map((s) => s.id)),
      ]),
    ),
  );

  const handleSeriesToggle = useCallback(
    (chartId: string, seriesId: string, shiftKey: boolean) => {
      setVisibleByChart((prev) => {
        const chart = PROVENANCE_CHARTS.find((c) => c.id === chartId);
        if (!chart) return prev;
        const allIds = chart.series.map((s) => s.id);
        let next: Set<string>;
        if (shiftKey) {
          next = new Set([seriesId]);
        } else {
          next = new Set(prev[chartId]);
          if (next.has(seriesId)) {
            next.delete(seriesId);
            // Never leave a chart empty — restore all instead (EnergyTable idiom).
            if (next.size === 0) next = new Set(allIds);
          } else {
            next.add(seriesId);
          }
        }
        return { ...prev, [chartId]: next };
      });
    },
    [],
  );

  const hoveredIndex = view ? nearestIndex(view.timestamps, focusedTime) : null;
  const hoveredTimestamp =
    view && hoveredIndex !== null ? view.timestamps[hoveredIndex] : null;

  const handleHoverIndexChange = useCallback(
    (index: number | null) => {
      setFocusedTime(index !== null ? (view?.timestamps[index] ?? null) : null);
    },
    [view, setFocusedTime],
  );

  // Range label built from the ACTUAL plotted window (view.windowStart/windowEnd), not a separate
  // "now"-based guess — so it can never disagree with what the charts show (e.g. live mode's true
  // end is yesterday, not today, since today's row may still be a checkpoint-only partial).
  const days = view?.windowed.days ?? [];
  const rangeLabel =
    days.length > 0 ? formatYMDRange(days[0], days[days.length - 1]) : "";

  // The currently-viewed window came back with zero rows (e.g. it's entirely before the site's
  // first day) — data is contiguous forward from there, so stepping further back can only ever be
  // empty too. Disable "older" rather than let the user page indefinitely into empty windows.
  const atHistoryStart = view !== null && days.length === 0;

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-2 sm:p-4">
      <div className="flex justify-end items-center gap-2 sm:gap-4 pb-2">
        <span
          className="text-xs sm:text-sm text-gray-400"
          style={{ fontFamily: "DM Sans, system-ui, sans-serif" }}
        >
          {rangeLabel}
        </span>
        <div className="inline-flex rounded-md shadow-sm" role="group">
          <button
            onClick={older}
            disabled={isPending || atHistoryStart}
            className="px-2 py-1 text-sm font-medium border rounded-l-lg bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-none"
            title={
              atHistoryStart ? "No earlier history" : "Older (previous period)"
            }
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={newer}
            disabled={isPending || olderSteps === 0}
            className="px-2 py-1 text-sm font-medium border-l-0 border rounded-r-lg bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-none"
            title="Newer (next period)"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <PeriodSwitcher
          value={period}
          onChange={setPeriod}
          periods={PANEL_PERIODS}
        />
      </div>

      {isError ? (
        <div className="text-sm text-red-400 py-8 text-center">
          Failed to load battery-provenance history
        </div>
      ) : isPending || !view ? (
        <div className="animate-pulse space-y-4 py-2">
          {PROVENANCE_CHARTS.map((c) => (
            <div key={c.id} className="h-44 bg-gray-700/40 rounded" />
          ))}
        </div>
      ) : view.lastDataIndex === null ? (
        <div className="text-sm text-gray-400 py-8 text-center">
          No battery-provenance history for this window
        </div>
      ) : (
        <div
          className={`flex flex-col md:flex-row md:gap-4 transition-opacity duration-200 ${
            isFetching && !isPending ? "opacity-60" : ""
          }`}
        >
          <div className="flex-1 min-w-0 space-y-3">
            {PROVENANCE_CHARTS.map((chart) => (
              <ProvenanceChart
                key={chart.id}
                def={chart}
                timestamps={view.timestamps}
                seriesValues={view.seriesValues}
                visibleSeries={visibleByChart[chart.id] ?? new Set()}
                hoveredTimestamp={hoveredTimestamp}
                onHoverIndexChange={handleHoverIndexChange}
                timeRange={period}
                windowStart={view.windowStart}
                windowEnd={view.windowEnd}
                bandAnnotations={
                  chart.bandField === "recal" ? view.recalBands : []
                }
              />
            ))}
          </div>
          <div className="w-full md:w-72 flex-shrink-0 mt-4 md:mt-0">
            <div className="md:sticky md:top-4">
              <ProvenanceValueTable
                view={view.windowed}
                seriesValues={view.seriesValues}
                hoveredIndex={hoveredIndex}
                defaultIndex={view.lastDataIndex}
                visibleByChart={visibleByChart}
                onSeriesToggle={handleSeriesToggle}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The battery-provenance history panel: the 7 registry-defined daily charts over a navigable
 * window (1Y default, 30D zoom), a synced crosshair, and a value table tracking the hover. Wrapped
 * in its own ChartFocusProvider so the charts + the navigator label share one focus instant
 * without leaking into other cards on the page.
 */
export default function BatteryProvenancePanel(
  props: BatteryProvenancePanelProps,
) {
  return (
    <ChartFocusProvider>
      <PanelInner {...props} />
    </ChartFocusProvider>
  );
}
