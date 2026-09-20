"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, Settings } from "lucide-react";
import Tile from "@/components/Tile";
import Value from "@/components/ui/value";
import ProgressRing from "@/components/ui/progress-ring";
import TrendRow from "@/components/ui/trend-row";
import { TILE_CHIP } from "@/lib/tile-style";
import GeneratorControlDialog from "@/components/GeneratorControlDialog";
import { subjectOf, useAreaDatum } from "@/components/dashboard/cards/shared";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { getPeriodDuration } from "@/lib/charts/temporal";
import { formatDollars, formatKwh, pricedTotal } from "@/lib/provenance-format";
import { runPeriodsQuery } from "@/lib/queries/runPeriods";
import { queryKeys } from "@/lib/queries/keys";
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
  openRunIsLive,
  panelIsAuto,
  runTimeWords,
} from "@/lib/control/generator-ref";
import type { TilePlugin, TileRenderProps } from "./types";
import { getMeasurementTime, getPointValue, getTextValue } from "./shared";

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
 * The hero is the engine's state word, coloured by state (see `heroColor`); a run LiveOne commanded
 * counts down as a ring beside it. Under it, two Trends rows: the engine's vitals while it turns, and
 * what it generated (this run, or this period between runs) with the fuel cost as the caption — the
 * Grid tile's `pricedTotal` rule, so neither tile shows a confident total for a period that was only
 * partly priced.
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

  // rpm splits a commanded run into Starting and Running — the hub reports `running:hub` the instant
  // it latches, which put the hero "Running" over an "Engine 0 rpm 0.0 Hz" row for the first ~10 s.
  const status = describeGeneratorState(state, mode, { rpm });

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
  /**
   * That same entry's VALUE: 1/0 for "is a run open right now", or null when the derived point
   * hasn't reached this area's serving map. Free — it is the row the line above already reads —
   * and, unlike the run-periods response below, it rides a query that actually polls.
   */
  const liveRunning = getPointValue(latest, GENERATOR_RUNNING_PATH);
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

  /**
   * The current run, asked for SEPARATELY from the period totals — and deliberately not through the
   * query above.
   *
   * 🛑 That query follows the dashboard's temporal range, and on Month or Year the range ENDS
   * before now. A run in progress falls outside its own window, `running` comes back false, and the
   * tile silently loses the three things that describe the run happening right now: the "Since …"
   * row, its energy and cost, and (via `runStartIso` below) the countdown clause under the hero.
   * The hero still said "Running", so the tile disagreed with itself.
   *
   * A one-row paged read is the smallest question that always means "now" — the endpoint's paged
   * mode is most-recent-first and carries the same `running` flag — and `modeKey` keys it apart from
   * the range read, so the two coexist rather than evicting each other.
   */
  const { data: currentRuns } = useQuery({
    ...runPeriodsQuery({
      systemId: runsSystemId ?? 0,
      role: "generator",
      limit: 1,
      offset: 0,
    }),
    // Gated on the LIVE point: `openRunIsLive` discards this response whenever `liveRunning === 0`,
    // so fetching while the engine is provably stopped is a ~140 ms read nobody can consume. `null`
    // (derived point absent from the serving map) still fetches — the believe-the-live-point rule
    // cuts only where the point positively says "stopped" (#406).
    enabled: runsSystemId != null && liveRunning !== 0,
    // An OPEN run's energy and cost keep accruing (the minutely reconcile re-allocates it over
    // [start, now]), so the row froze at whatever the last fetch happened to see — "0.3 kWh" for
    // the rest of the run. One row, once a minute, and only while an engine is actually turning:
    // off this poll goes the moment `running` drops, and it never starts on a site whose derived
    // point is absent (null ⇒ false).
    refetchInterval: liveRunning === 1 ? 60_000 : false,
  });

  /**
   * The OPEN run, if there is one. `running` is the server's own open-period flag; the event it
   * points at carries the whole run — its start, and its energy/cost accumulated so far (the
   * minutely reconcile allocates an open run over [start, now], so this is live, not zero).
   *
   * 🛑 Under `openRunIsLive`, because that flag arrives on a query nobody polls and the fresher
   * copy of the same flag is sitting in `latest` — see the function for the failure it closes.
   */
  const openRun = openRunIsLive(currentRuns?.running, liveRunning)
    ? (currentRuns?.events?.find((e) => e.running) ?? null)
    : null;
  const openRunStart = openRun?.startTimeISO ?? null;
  const openRunFor = compactElapsed(openRunStart, nowMs);

  /**
   * Go and re-read the runs when the live flag CHANGES — the other half of the veto above.
   *
   * The veto alone only stops the tile lying; it doesn't fetch the truth. On a stop this is what
   * lands the finished run's real end and energy and folds it into the "This period" total; on a
   * start it is what makes the "Since …" row appear at all for a run WE didn't command (an
   * inverter-started run opens no dialog, so nothing else ever invalidates).
   *
   * Edge-triggered via a ref rather than a plain dependency: on mount `prev` is null and we only
   * record, because the queries have just fetched and a second round-trip would buy nothing. A null
   * on either side is "no opinion" and never counts as an edge, so a site without the derived point
   * is left exactly as it was.
   */
  const queryClient = useQueryClient();
  const prevRunningRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevRunningRef.current;
    prevRunningRef.current = liveRunning;
    if (prev == null || liveRunning == null || prev === liveRunning) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.runPeriodsForDevice(runsSystemId ?? 0),
    });
  }, [liveRunning, runsSystemId, queryClient]);

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
   *
   * That lag is why there is a THIRD state, `null`: the engine is turning but the detector has not
   * opened its run yet (~1–2 min). The period total is then stale in the most misleading way — it
   * describes the world before this run, under a hero that says the engine is going — so the row is
   * withheld until there is something true to put in it. Between runs the period total is exactly
   * right, and is what the row has always shown.
   */
  const scope: {
    short: string;
    long: React.ReactNode;
    energyKwh: number | null;
    cents: number | null;
    /** Show a zero: a run one minute old has legitimately made ~nothing yet, and hiding the row
     *  exactly then hides it during the run the reader opened the dashboard to watch. */
    showZero: boolean;
  } | null = openRun
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
    : status.isRunning
      ? // Turning, but the detector has not caught up. Say nothing rather than the wrong thing.
        null
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

  const showControls = canControl && systemId != null;
  // The lockout is appended rather than replacing the hero when the engine is turning: a running
  // engine is the more urgent fact, but the panel state still has to be visible.
  const detailWords =
    status.isRunning && mode && !panelIsAuto(mode)
      ? `${status.detail ? `${status.detail} · ` : ""}panel in ${mode}`
      : status.detail;

  /**
   * A run WE commanded counts down as a ring: the fraction of the requested run still to go, with
   * the minutes inside. Only when both ends are known — the deadline (`stop_at`) and the run's start
   * (the open run's event) — since a ring needs a whole to be a fraction of. Otherwise the countdown
   * stays the words it always was, in the line under the hero.
   */
  const stopAtMs = stopAt != null ? stopAt * 1000 : null;
  const startMs = openRunStart ? Date.parse(openRunStart) : NaN;
  const countdown =
    status.isCommandedRun &&
    time &&
    stopAtMs != null &&
    Number.isFinite(startMs) &&
    stopAtMs > startMs
      ? Math.min(1, Math.max(0, (stopAtMs - nowMs) / (stopAtMs - startMs)))
      : null;

  /**
   * The qualifying line: what is running the engine, and how long it has left — a clause of one
   * sentence ("LiveOne request, stops in 23 min"), not another measurement. When the countdown is
   * drawn as a ring (a tile wide enough to hold it beside the hero) the words give way to it; in a
   * narrower tile the words ARE the countdown.
   */
  const heroDetail = !time ? (
    detailWords
  ) : (
    <>
      {detailWords}
      <span className={countdown != null ? "@[180px]:hidden" : undefined}>
        {detailWords ? ", " : ""}
        {detailWords ? time.long.toLowerCase() : time.long}{" "}
        <span className="text-ink">{time.value}</span>
      </span>
    </>
  );

  /**
   * The hero word is coloured by STATE — the generator has no series colour of its own
   * (`CHART_COLORS` has no generator), so its word says what the engine is doing: green while it
   * turns (and pulsing, see `.shimmer-text`), red for "Locked out" / "Stop failing" — both mean it
   * will not do what the reader expects — and the idle grey when it is off.
   */
  const heroColor =
    status.tone === "warning"
      ? "text-danger"
      : status.isRunning
        ? ROLE_CHROME.battery.value
        : IDLE_CHROME.value;

  const showEngine = status.isRunning && (rpm != null || hz != null);
  const showScope =
    scope != null &&
    scope.energyKwh != null &&
    (scope.showZero || scope.energyKwh > 0);

  return (
    <Tile
      title="Generator"
      icon={<Gauge />}
      value={status.label}
      valueColor={heroColor}
      // A turning engine pulses. `.shimmer-text` sweeps a dimmed band THROUGH the glyphs, so unlike
      // the skeleton `.shimmer` the word stays fully readable — this says "live", not "loading".
      valueClassName={status.isRunning ? "shimmer-text" : undefined}
      heroAside={
        countdown != null && time ? (
          <ProgressRing
            fraction={countdown}
            color={ROLE_CHROME.battery.rgb}
            strokeRatio={0.16}
            className="hidden h-11 w-11 shrink-0 @[180px]:block"
          >
            <span className="text-[10px] font-bold leading-none text-ink">
              {time.value.replace(/\u00A0min$/, "m")}
            </span>
          </ProgressRing>
        ) : undefined
      }
      accessory={
        <>
          {/* The error TEXT lives in the dialog, where there is room for a sentence; out here it
              is only a signal that there is something to go and read. */}
          {lastError && (
            <span
              className={`${TILE_CHIP} text-[13px] font-bold text-danger`}
              title="The generator reported an error — open the controls to read it"
            >
              !
            </span>
          )}
          {showControls && (
            // Top-right, exactly where TeslaSmallCard puts its charge-control cog — the corner a
            // reader looks in for settings.
            <button
              type="button"
              onClick={() => setControlsOpen(true)}
              aria-label="Generator controls"
              className={`${TILE_CHIP} text-tile-ink-soft transition-colors hover:bg-wash-strong hover:text-ink`}
            >
              <Settings className="h-4 w-4" />
            </button>
          )}
        </>
      }
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={
        getMeasurementTime(latest, GENERATOR_STATUS_PATH) ?? undefined
      }
      extraInfo={heroDetail ?? undefined}
      overlay={
        showControls ? (
          <GeneratorControlDialog
            systemId={systemId as number}
            open={controlsOpen}
            onOpenChange={setControlsOpen}
            latest={latest}
          />
        ) : undefined
      }
      extra={
        showEngine || showScope ? (
          <div className="mt-auto space-y-2">
            {/* Engine vitals, only while it is turning — 0 rpm on a stopped engine is noise. */}
            {showEngine && (
              <TrendRow
                label="Engine"
                value={
                  rpm != null ? (
                    <Value value={String(Math.round(rpm))} unit="rpm" />
                  ) : (
                    "—"
                  )
                }
                caption={
                  hz != null ? <Value value={hz.toFixed(1)} unit="Hz" /> : null
                }
              />
            )}
            {showScope && scope && (
              <TrendRow
                label={
                  <>
                    {/* Keyed on the TILE's width — see `@container` on the tile root. */}
                    <span className="@[200px]:hidden">{scope.short}</span>
                    <span className="hidden @[200px]:inline">{scope.long}</span>
                  </>
                }
                value={
                  <Value value={formatKwh(scope.energyKwh ?? 0)} unit="kWh" />
                }
                // "—" = not fully priced — never a misleading $0. Same rule as the Grid tile.
                caption={scope.cents != null ? formatDollars(scope.cents) : "—"}
              />
            )}
          </div>
        ) : undefined
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
