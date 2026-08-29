"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge, Settings } from "lucide-react";
import Tile from "@/components/Tile";
import Value from "@/components/ui/value";
import GeneratorControlDialog from "@/components/GeneratorControlDialog";
import { subjectOf, useAreaDatum } from "@/components/dashboard/cards/shared";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { getPeriodDuration } from "@/lib/charts/temporal";
import { formatDollars, formatKwh, pricedTotal } from "@/lib/provenance-format";
import { runPeriodsQuery } from "@/lib/queries/runPeriods";
import { IDLE_CHROME, ROLE_CHROME } from "@/lib/role-chrome";
import {
  GENERATOR_CONTROL_PATHS,
  GENERATOR_HZ_PATHS,
  GENERATOR_MODE_PATH,
  GENERATOR_RPM_PATHS,
  GENERATOR_RUNNING_PATH,
  GENERATOR_STATUS_PATH,
  GENERATOR_STOP_AT_PATH,
  GENERATOR_ERROR_PATH,
  describeGeneratorState,
  firstPresentPath,
  panelIsAuto,
  runTimeWords,
} from "@/lib/control/generator-ref";
import type { TilePlugin, TileRenderProps } from "./types";
import { getMeasurementTime, getPointValue, getTextValue } from "./shared";

/**
 * One sub-row: label, then two right-aligned numeric cells that line up down the tile.
 *
 * The label carries a short and a long form, like the Grid tile's `PeriodRow`, because the first
 * column is `auto`: a long label in a narrow tile wraps to two lines and drags the numbers out of
 * alignment with the rows above it. `whitespace-nowrap` is the backstop for the same reason —
 * squeezing the numeric columns is recoverable, wrapping the label is not.
 */
function Row({
  short,
  long,
  left,
  right,
}: {
  short: string;
  long: string;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <>
      <span className="whitespace-nowrap">
        <span className="md:hidden">{short}</span>
        <span className="hidden md:inline">{long}</span>
      </span>
      <span className="text-right">{left}</span>
      <span className="text-right">{right}</span>
    </>
  );
}

/**
 * The generator tile — what the engine is doing, what it produced, and how long it has left.
 *
 * Chrome is `ROLE_CHROME.neutral`, which lib/role-chrome.ts reserves for "tiles with no series of
 * their own": the generator has no entry in `CHART_COLORS`, and inventing one to tint a tile would
 * be a palette decision made for the wrong reason. State rides on the hero word and the amber
 * countdown — the amber-on-neutral treatment `TeslaSmallCard` already uses for its armed limit.
 *
 * The three sub-rows share the Grid tile's `[auto_1fr_auto]` sub-grid, so the two tiles' numbers
 * line up when they sit side by side, and its `pricedTotal` rule, so neither can show a confident
 * money total for a period that was only partly priced.
 */
function GeneratorTile({
  latest,
  systemId,
  canControl,
  staleThresholdSeconds,
}: TileRenderProps) {
  const [controlsOpen, setControlsOpen] = useState(false);

  const state = getTextValue(latest, GENERATOR_STATUS_PATH);
  const mode = getTextValue(latest, GENERATOR_MODE_PATH);
  const stopAt = getPointValue(latest, GENERATOR_STOP_AT_PATH);
  const lastError = getTextValue(latest, GENERATOR_ERROR_PATH);
  // Resolved rather than hardcoded: the readings still arrive on the pre-#150 logical paths.
  const rpmPath = firstPresentPath(latest, GENERATOR_RPM_PATHS);
  const rpm = rpmPath ? getPointValue(latest, rpmPath) : null;
  const hzPath = firstPresentPath(latest, GENERATOR_HZ_PATHS);
  const hz = hzPath ? getPointValue(latest, hzPath) : null;

  const status = describeGeneratorState(state, mode);

  // A commanded run's countdown must tick without waiting for the next 15 s push, and `stop_at` is
  // an absolute instant, so re-rendering on a clock is enough — there is nothing to re-fetch.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // Period totals under the hero: what the generator produced, and what the fuel cost, over the
  // DASHBOARD's selected period — so this tile follows the shared temporal navigator like the
  // charts and the Grid tile.
  //
  // 🛑 Addressed at the DETECTOR's device, not this tile's subject. Run periods are keyed by the
  // member device that owns the run detector (the SP-PRO at Daylesford), which is NOT the DeepSea
  // controller these engine registers come from, and NOT the synthetic area handle. The producing
  // device is read off the payload's own `sourceSystemId` for the derived running point — the same
  // mechanism `datumCanControlPoint` uses to answer "which device would this actually touch".
  const runsSystemId =
    latest[GENERATOR_RUNNING_PATH]?.sourceSystemId ?? systemId;
  const { datum, paused } = useAreaDatum(systemId ?? 0, {
    enabled: systemId != null,
  });
  const tz = subjectOf(datum)?.timezoneOffsetMin ?? 600;
  const { period, start, end, isHistoricalMode } = useTemporalRange({
    timezoneOffsetMin: tz,
  });
  // Same params RunsCard passes, so a dashboard carrying both shares one key and one request.
  const { data: runs } = useQuery({
    ...runPeriodsQuery(
      isHistoricalMode && start && end
        ? { systemId: runsSystemId ?? 0, role: "generator", start, end }
        : {
            systemId: runsSystemId ?? 0,
            role: "generator",
            period: `${Math.round(getPeriodDuration(period) / 86_400_000)}d`,
          },
    ),
    enabled: runsSystemId != null,
  });

  const energyKwh = runs?.totalEnergyKwh ?? null;
  const cents = pricedTotal(
    runs?.costKnownKwh ? (runs.totalCostC ?? null) : null,
    runs?.costKnownKwh ?? 0,
    energyKwh ?? 0,
  );
  // The open run's start, for the elapsed count on a run we did not command (and so have no
  // deadline for). `running` is the server's own open-period flag.
  const openRunStart = runs?.running
    ? (runs.events?.find((e) => e.running)?.startTimeISO ?? null)
    : null;

  const time = runTimeWords({
    isCommandedRun: status.isCommandedRun,
    isRunning: status.isRunning,
    stopAtEpochSec: stopAt,
    runStartIso: openRunStart,
    nowMs,
  });

  const chrome = status.isRunning ? ROLE_CHROME.neutral : IDLE_CHROME;
  const showControls = canControl && systemId != null;
  // The lockout is appended rather than replacing the hero when the engine is turning: a running
  // engine is the more urgent fact, but the panel state still has to be visible.
  const heroDetail =
    status.isRunning && mode && !panelIsAuto(mode)
      ? `${status.detail ? `${status.detail} · ` : ""}panel in ${mode}`
      : status.detail;

  return (
    <Tile
      title="Generator"
      value={status.label}
      icon={<Gauge className="w-6 h-6" />}
      iconColor={status.tone === "warning" ? "text-red-400" : chrome.icon}
      bgColor={chrome.tint}
      borderColor={chrome.border}
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={
        getMeasurementTime(latest, GENERATOR_STATUS_PATH) ?? undefined
      }
      extraInfo={heroDetail ?? undefined}
      overlay={
        showControls ? (
          <>
            {/* Bottom-right: the tile's own icon owns the top-right corner on desktop, and the
                value/rows column is left-aligned, so this is the one corner always free. */}
            <button
              type="button"
              onClick={() => setControlsOpen(true)}
              aria-label="Generator controls"
              className="absolute bottom-2 right-2 z-20 flex items-center justify-center text-gray-500 transition-colors hover:text-gray-200"
            >
              <Settings className="h-4 w-4" />
            </button>
            <GeneratorControlDialog
              systemId={systemId as number}
              open={controlsOpen}
              onOpenChange={setControlsOpen}
              latest={latest}
            />
          </>
        ) : undefined
      }
      extra={
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-1.5 text-[10px] md:text-xs text-gray-400 tabular-nums">
          {/* Engine vitals, only while it is turning — 0 rpm on a stopped engine is noise. */}
          {status.isRunning && (rpm != null || hz != null) && (
            <Row
              short="Eng"
              long="Engine"
              left={
                rpm != null ? (
                  <Value value={String(Math.round(rpm))} unit="rpm" />
                ) : (
                  "—"
                )
              }
              right={
                hz != null ? <Value value={hz.toFixed(1)} unit="Hz" /> : "—"
              }
            />
          )}
          {time && (
            <Row
              short={time.short}
              long={time.long}
              left={
                <span
                  className={
                    status.isCommandedRun ? "text-amber-400/90" : undefined
                  }
                >
                  {time.value}
                </span>
              }
              right=""
            />
          )}
          {energyKwh != null && energyKwh > 0 && (
            <Row
              short="Gen"
              long="Generated"
              left={<Value value={formatKwh(energyKwh)} unit="kWh" />}
              // "—" = not fully priced — never a misleading $0. Same rule as the Grid tile.
              right={cents != null ? formatDollars(cents) : "—"}
            />
          )}
          {/* The error TEXT lives in the dialog, where there is room for a sentence; out here it
              is only a signal that there is something to go and read. */}
          {lastError && (
            <Row
              short=""
              long=""
              left=""
              right={<span className="text-red-400">●</span>}
            />
          )}
        </div>
      }
    />
  );
}

export const generatorTile: TilePlugin = {
  kind: "tile",
  type: "generator",
  // The hub's control-state point is the gate rather than any engine register: it is pushed by the
  // supervisor itself (merged in tickOnce, NOT produced inside read()), so it is present even
  // during the Modbus outage that would blank every other generator point — which is precisely
  // when a user most wants the tile to still be there saying `stop-failing`.
  isAvailable: ({ latest }) =>
    getTextValue(latest, GENERATOR_STATUS_PATH) !== null,
  controlPaths: GENERATOR_CONTROL_PATHS,
  Render: GeneratorTile,
};
