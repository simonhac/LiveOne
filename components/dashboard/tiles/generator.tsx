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
  long: React.ReactNode;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <>
      <span className="whitespace-nowrap">
        {/* Keyed on the TILE's width, not the viewport's — see `@container` on Tile. `md:` was a
            viewport query, so on any desktop the long label won every time and a 150px tile in a
            dashboard grid rendered "This period" where it had room for "Period". */}
        <span className="@[130px]:hidden">{short}</span>
        <span className="hidden @[130px]:inline">{long}</span>
      </span>
      {/* Both number columns are RIGHT-aligned, so the two rows' magnitudes sit under one another
          and the tile has one clean right edge. */}
      <span className="text-right">{left}</span>
      <span className="text-right">{right}</span>
    </>
  );
}

/**
 * How long an open run has been going, compactly: "45m" under an hour, "4.2h" over it.
 *
 * Deliberately NOT `formatSecondsAsDuration` ("4h 12m"), which is the house spelling everywhere it
 * has room. This is a SUFFIX inside a grid label that already has to fit beside two numbers, and it
 * only appears at all when the tile is wide enough for the long label — so the whole point is that
 * it is short. One decimal hour is the shortest form that still distinguishes a 4-hour run from a
 * 5-hour one.
 */
function compactElapsed(
  startIso: string | null | undefined,
  nowMs: number,
): string | null {
  if (!startIso) return null;
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return null;
  const minutes = Math.floor((nowMs - startMs) / 60_000);
  if (minutes < 0) return null;
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
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

  // The OPEN run, if there is one. `running` is the server's own open-period flag; the event it
  // points at carries the whole run — its start, and its energy/cost accumulated so far (the
  // minutely reconcile allocates an open run over [start, now], so this is live, not zero).
  const openRun = runs?.running
    ? (runs.events?.find((e) => e.running) ?? null)
    : null;
  const openRunStart = openRun?.startTimeISO ?? null;
  const openRunFor = compactElapsed(openRunStart, nowMs);

  /**
   * What the "Generated" row is ABOUT, which changes with the engine.
   *
   * Mid-run the dashboard period's total is the wrong answer to the question the reader is asking:
   * they are watching a generator turn and want to know what THIS run has made. Between runs the
   * period total is exactly right, and is what the row has always shown.
   *
   * 🛑 Gated on `openRun` — the EVENT — and never on `status.isRunning`. The status word comes from
   * the live KV map and the event from a run-periods read that can be a couple of minutes behind;
   * gating on the event is the only arrangement where the label and the number cannot be describing
   * two different worlds ("Since 9:43am" over a period total).
   */
  const scope: {
    short: string;
    long: React.ReactNode;
    energyKwh: number | null;
    cents: number | null;
    /** Show a zero: a run one minute old has legitimately made ~nothing yet, and hiding the row
     *  exactly then hides it during the run the reader opened the dashboard to watch. */
    showZero: boolean;
  } = openRun
    ? {
        // The narrowest rung of the ladder: the span alone, since at this width the clock time
        // costs more than it tells you.
        short: openRunFor ?? openRun.startTime,
        // The elapsed time rides in the LONG label only — the short/long split is already the
        // tile's "is there room" mechanism, and a narrow tile needs the clock more than the span.
        /**
         * Two spellings of the same fact, chosen by how much room the TILE has — see `@container`
         * on Tile. The label column is `auto` and nowrap, so a label that does not fit does not
         * wrap: it pushes the two numbers beside it off the card, which is what a narrow tile was
         * doing with the full form.
         *
         * Wide: "Since 11:43pm (1.3h)" — the clock time first, because that is the fact you cannot
         * derive. Narrow: "Last 1.3h", which says the thing that still fits. The threshold is
         * against the tile's CONTENT box (what an inline-size query measures), so ~240px lands
         * between the 220px tile that clipped and the 300px one that did not.
         */
        long: openRunFor ? (
          <>
            <span className="@[240px]:hidden">Last {openRunFor}</span>
            <span className="hidden @[240px]:inline">
              Since {openRun.startTime} ({openRunFor})
            </span>
          </>
        ) : (
          <>Since {openRun.startTime}</>
        ),
        energyKwh: openRun.energyKwh,
        // Per-run there is no coverage denominator to weigh (the route credits a run's WHOLE energy
        // as known the moment it has a cost), so the honest guard is the one RunsCard uses.
        cents: openRun.costC ?? null,
        showZero: true,
      }
    : {
        short: "Period",
        long: "This period",
        energyKwh: runs?.totalEnergyKwh ?? null,
        cents: pricedTotal(
          runs?.costKnownKwh ? (runs.totalCostC ?? null) : null,
          runs?.costKnownKwh ?? 0,
          runs?.totalEnergyKwh ?? 0,
        ),
        showZero: false,
      };

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
  const detailWords =
    status.isRunning && mode && !panelIsAuto(mode)
      ? `${status.detail ? `${status.detail} · ` : ""}panel in ${mode}`
      : status.detail;

  /**
   * The qualifying line: what is running the engine, and how long it has left.
   *
   * The countdown sits HERE rather than in its own sub-grid row because it is a clause of the same
   * sentence — "LiveOne request, stops in 23 min" — not another measurement. As a row it
   * had a label in the label column and a lone value under the rpm, which read as a third number
   * the tile did not have. The minutes keep the amber they had: on a commanded run that colour is
   * the deadline WE set, and it is the one thing on this tile the reader can still change.
   */
  const heroDetail = !time ? (
    // Nothing to colour, so the line stays the plain string it has always been.
    detailWords
  ) : (
    <>
      {detailWords}
      {detailWords ? ", " : ""}
      {detailWords ? time.long.toLowerCase() : time.long}{" "}
      <span className={status.isCommandedRun ? "text-amber-400/90" : undefined}>
        {time.value}
      </span>
    </>
  );

  return (
    <Tile
      title="Generator"
      value={status.label}
      // The cog takes the top-right corner when the viewer can command this generator. For a
      // viewer who cannot, there is no cog to take it, and dropping the icon anyway would leave the
      // tile with an empty corner and no role marker — so the Gauge stays exactly then.
      icon={showControls ? undefined : <Gauge className="w-6 h-6" />}
      iconColor={status.tone === "warning" ? "text-red-400" : chrome.icon}
      // A red hero for "Locked out" / "Stop failing": the words alone are easy to read past on a
      // wall of tiles, and both mean the generator will not do what the reader expects of it.
      //
      // A running engine's hero is pure white rather than the default gray-100, because the shimmer
      // below rests at 80% of THIS colour — so this is what makes the resting state exactly 80%
      // white, and it is the same knob that keeps a red "Running" shimmering in red.
      valueColor={
        status.tone === "warning"
          ? "text-red-400"
          : status.isRunning
            ? "text-white"
            : undefined
      }
      // A turning engine pulses. `.shimmer-text` sweeps a highlight THROUGH the glyphs, so unlike
      // the skeleton `.shimmer` the word stays fully readable — this says "live", not "loading".
      valueClassName={status.isRunning ? "shimmer-text" : undefined}
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
            {/* Top-right, exactly where TeslaSmallCard puts its charge-control cog — the corner a
                reader looks in for settings. It was bottom-right, tucked under the "Generated"
                row's dollars, where it read as decoration rather than a control. The role icon
                yields the corner (see `icon` below) rather than the two sharing it. */}
            <button
              type="button"
              onClick={() => setControlsOpen(true)}
              aria-label="Generator controls"
              className="absolute top-2 right-2 z-40 flex items-center justify-center text-gray-500 transition-colors hover:text-gray-200"
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
          {scope.energyKwh != null &&
            (scope.showZero || scope.energyKwh > 0) && (
              <Row
                short={scope.short}
                long={scope.long}
                left={<Value value={formatKwh(scope.energyKwh)} unit="kWh" />}
                // "—" = not fully priced — never a misleading $0. Same rule as the Grid tile.
                right={scope.cents != null ? formatDollars(scope.cents) : "—"}
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
