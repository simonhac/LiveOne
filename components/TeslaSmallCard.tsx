"use client";

import { useState } from "react";
import { useDebugSizeBadge } from "@/components/ui/debug-size-badge";
import { useQuery } from "@tanstack/react-query";
import Value from "@/components/ui/value";
import ProgressRing from "@/components/ui/progress-ring";
import DirectionChip, {
  FLOW_DEAD_BAND_W,
} from "@/components/ui/direction-chip";
import TrendRow from "@/components/ui/trend-row";
import { ChevronRight, ChevronsRight, Settings } from "lucide-react";
import TileSurface from "@/components/ui/tile-surface";
import {
  TILE_CAPTION,
  TILE_CHIP,
  TILE_RING,
  TILE_RING_VALUE,
} from "@/lib/tile-style";
import { IDLE_CHROME, ROLE_CHROME } from "@/lib/role-chrome";
import { TeslaMark } from "@/lib/tesla-icons";
import { getEvStatus, getEvStatusWords } from "@/lib/vendors/tesla/status";
import TeslaControlDialog from "@/components/TeslaControlDialog";
import { chargeAutomationsQuery } from "@/lib/queries/automations";
import { pointIdOf } from "@/lib/control/point-ref";
import {
  describeChargeLimit,
  formatChargeLimitCompact,
  formatChargeLimitLine,
  selectChargeLimits,
} from "@/lib/automations/progress";

interface LatestValue {
  value: number | string | boolean;
  measurementTime?: Date;
  metricUnit?: string;
  displayName?: string;
  /** The source point's `pt_` TypeID — what a charge limit is addressed by. */
  pointReference?: string;
}

interface TeslaSmallCardProps {
  /**
   * Latest values from KV cache, keyed by logical path
   */
  latest: Record<string, LatestValue | null> | null;
  /** Device id — required to enable the charge-control dialog. */
  systemId?: number;
  /** Whether the current user may issue charge commands (owner or admin). */
  canControl?: boolean;
  /**
   * The `ar_` TypeID of the area subject this tile was served as. Optional: absent for a
   * device-subject tile and for the prop-only card gallery, and its absence simply means no
   * charge-limit indicator.
   */
  areaId?: string | null;
}

/**
 * Get a numeric value from latest values store
 */
function getNumericValue(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): number | null {
  const point = latest?.[path];
  if (!point) return null;
  if (typeof point.value === "number") return point.value;
  if (typeof point.value === "string") {
    const parsed = parseFloat(point.value);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Get a string value from latest values store
 */
function getStringValue(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): string | null {
  const point = latest?.[path];
  if (!point) return null;
  if (typeof point.value === "string") return point.value;
  if (typeof point.value === "number") return String(point.value);
  return null;
}

/**
 * Get a boolean value from latest values store.
 *
 * Boolean points round-trip through KV as 1/0 — `convertValueByMetadata` only
 * special-cases `metricUnit === "text"`, so everything else is stored numeric.
 */
function getBooleanValue(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): boolean | null {
  const point = latest?.[path];
  if (!point) return null;
  if (typeof point.value === "boolean") return point.value;
  if (typeof point.value === "number") return point.value !== 0;
  if (typeof point.value === "string")
    return point.value === "true" || point.value === "1";
  return null;
}

/**
 * Format hours to "Xh Ym" format
 */
function formatTimeRemaining(hours: number): string {
  if (hours <= 0) return "";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

/**
 * The ring is the EV's THEME colour — `CHART_COLORS.ev`, the colour EV charging has in every chart
 * and the Sankey — running to a lighter red at its tip, like the battery tile's green. It used to be a
 * red→orange→yellow→green SoC ramp, which made this the one tile whose colour said "how full"
 * rather than "what this is"; the number inside the ring already says how full.
 */
const EV_LIGHT_RGB = "rgb(248, 113, 113)"; // red-400

/**
 * Compact Tesla card — the SoC as a fat Activity-style ring, plus the car's state.
 *
 * Drawn on the shared tile surface (docs/architecture/tile-style.md): the Tesla mark sits in the
 * title slot, the cog is a grey disc top-right, the ring is centred, and the state reads as a caption
 * under it. The ring carries two extras: chevrons riding its tip while charging (doubled over
 * 10 kW), and a notch across it at the car's charge limit.
 *
 * One layout throughout; container queries (the tile's width, never the viewport) do the scaling.
 *
 * | Width    | Height | Ring D | Mark   | Cog    | Bottom                                       |
 * |----------|--------|--------|--------|--------|----------------------------------------------|
 * | 66px min | 110px  | 64     | Hidden | Hidden | state caption                                |
 * | 90px+    | 110px  | 64     | 16px   | Hidden | state caption                                |
 * | 120px+   | 110px  | 72     | 16px   | 28px   | state caption                                |
 * | 150px+   | 110px  | 72     | 16px   | 28px   | state/kW ↔ ETA (or limit), armed limit compact |
 * | 180px+   | 180px  | 108    | 20px   | 28px   | as 150px                                     |
 * | 220px+   | 180px  | 108    | 20px   | 28px   | … plus the direction chip                    |
 * | 260px+   | 180px  | 108    | 20px   | 28px   | … and the armed limit in full                |
 *
 * The bottom row starts at 150px rather than the 180px of Amber/OE grid: a phone's two-up tile is
 * under 180px, and the kW and ETA are what you look at the car tile for.
 */
export default function TeslaSmallCard({
  latest,
  systemId,
  canControl,
  areaId,
}: TeslaSmallCardProps) {
  const { rootRef, badge } = useDebugSizeBadge();
  const [controlsOpen, setControlsOpen] = useState(false);

  const showControls = canControl && systemId != null;

  // Armed charge limits for this area. Gated on `showControls` twice over: it spares viewers a
  // pointless request, and the route is area-OWNER gated, so firing it for a non-owner would earn
  // a guaranteed 403 that React Query would then retry.
  const limitsQuery = useQuery({
    ...chargeAutomationsQuery(areaId),
    enabled: !!areaId && !!showControls,
  });

  // Extract values from latest store
  const batterySoc = getNumericValue(latest, "ev.battery/soc");
  const chargingState = getStringValue(latest, "ev.charge/state");
  const chargePower = getNumericValue(latest, "ev.charge/power");
  const timeToFull = getNumericValue(latest, "ev.charge/remaining");
  const chargeLimit = getNumericValue(latest, "ev.charge.limit/soc");
  const shift = getStringValue(latest, "ev/shift");
  const pluggedIn = getBooleanValue(latest, "ev.charge/engaged");
  const chargeAdded = getNumericValue(latest, "ev.charge/added");

  // Don't render if no data available
  if (batterySoc === null) {
    return null;
  }

  const status = getEvStatus({ shift, chargingState, pluggedIn });
  const statusWords = getEvStatusWords(status);
  const isCharging = status === "charging";
  const batteryColor = ROLE_CHROME.ev.rgb;
  const batteryLight = EV_LIGHT_RGB;

  // The right-hand complication: the ETA while charging, else the car's charge limit.
  const etaLabel = `To ${chargeLimit ? `${Math.round(chargeLimit)}%` : "full"}`;
  const etaValue =
    isCharging && timeToFull ? formatTimeRemaining(timeToFull) : "";

  // Armed charge limit, if any: "Stopping at 20 kWh (12.4 so far)".
  //
  // 🛑 The "so far" figure is the DELTA above the automation's armed baseline, computed by the
  // evaluator's own `pointProgressKwh` — `ev.charge/added` is energy-above-PLUG-IN-baseline, so an
  // overnight top-up re-enters `Charging` already reading ~42 kWh and the raw counter would render
  // a freshly armed 20 kWh limit as long since blown.
  //
  // Shown only while the tile itself says charging: an armed rule on a car that has stopped is a
  // ≤1-tick transient the cron is about to disarm, and announcing it would be the fault it exists
  // to prevent. Without this line an automatic stop reads as a failure, so it is the core of the
  // feature rather than decoration.
  const armedLimit = isCharging
    ? (selectChargeLimits(
        limitsQuery.data?.automations ?? [],
        pointIdOf(latest, "ev.charge/active"),
      )
        .map((row) =>
          describeChargeLimit(
            row,
            chargeAdded != null ? { valueKwh: chargeAdded } : null,
            pointIdOf(latest, "ev.charge/added"),
            // Re-read on each 30 s refetch — deliberately no ticking timer for a minute-grained
            // number the cron only re-evaluates every 60 s anyway.
            Date.now(),
          ),
        )
        .find((d) => d.state === "armed") ?? null)
    : null;
  const limitText = armedLimit ? formatChargeLimitLine(armedLimit) : null;
  const limitCompact = armedLimit ? formatChargeLimitCompact(armedLimit) : null;

  // Determine if we should show double chevrons (high power charging)
  const isHighPower = chargePower !== null && chargePower > 10;

  return (
    <TileSurface
      rootRef={rootRef}
      className="min-w-[66px] self-stretch"
      surfaceClassName="flex flex-col min-h-[110px] @[180px]:min-h-[180px]"
      overlay={
        showControls ? (
          <TeslaControlDialog
            systemId={systemId as number}
            open={controlsOpen}
            onOpenChange={setControlsOpen}
            latest={latest}
            areaId={areaId}
          />
        ) : undefined
      }
    >
      {badge}

      {/* Title slot: the Tesla mark, white, a guest in the place a title goes. The charge-control
          cog takes the top-right corner as a grey disc — owner/admin only, once there is room. */}
      <div className="flex min-h-7 items-center justify-between gap-2">
        <TeslaMark className="w-4 h-4 @[180px]:w-5 @[180px]:h-5 text-ink" />
        {showControls && (
          <button
            type="button"
            onClick={() => setControlsOpen(true)}
            aria-label="Charging controls"
            className={`${TILE_CHIP} text-tile-ink-soft transition-colors hover:bg-wash-strong hover:text-ink`}
          >
            <Settings className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* The SoC ring — fat, round-capped, over a track of its own hue. Charging, the chevrons ride
          the arc's tip (the Activity Exercise ring); the charge limit is a notch across the ring. */}
      <div className="flex flex-1 items-center justify-center py-2">
        <ProgressRing
          fraction={batterySoc / 100}
          color={batteryColor}
          gradientTo={batteryLight}
          notch={chargeLimit != null ? chargeLimit / 100 : null}
          tipPulse={
            isCharging &&
            chargePower !== null &&
            chargePower * 1000 > FLOW_DEAD_BAND_W
          }
          tip={
            isCharging ? (
              isHighPower ? (
                <ChevronsRight
                  className="w-3 h-3 @[180px]:w-4 @[180px]:h-4 text-ink"
                  strokeWidth={3}
                />
              ) : (
                <ChevronRight
                  className="w-3 h-3 @[180px]:w-4 @[180px]:h-4 text-ink"
                  strokeWidth={3}
                />
              )
            ) : undefined
          }
          className={TILE_RING}
        >
          <div className={`${TILE_RING_VALUE} text-ink`}>
            <Value value={Math.round(batterySoc)} unit="%" />
          </div>
        </ProgressRing>
      </div>

      {/* Narrow (<150px): just the state, as a caption under the ring. */}
      <div
        className={`mt-1 truncate text-center ${TILE_CAPTION} @[150px]:hidden`}
      >
        {statusWords.join(" ")}
      </div>

      {/* From 150px: the bottom complications, as on Battery/Amber — state and kW on the left, the
          ETA (or the charge limit) on the right. Both values always render ("—" when idle) so the
          ring above doesn't move when charging starts. */}
      <div className="hidden @[150px]:block">
        <div className="flex items-end justify-between gap-2 @[180px]:gap-3">
          <TrendRow
            // The chip waits for 220px: below that the two columns need its width.
            chip={
              <DirectionChip
                direction={isCharging ? "down" : "idle"}
                color={ROLE_CHROME.ev.rgb}
                double={isHighPower}
                className="!hidden @[220px]:!grid"
              />
            }
            label={statusWords.join(" ")}
            value={
              isCharging && chargePower !== null ? (
                <Value value={chargePower} unit="kW" />
              ) : (
                "—"
              )
            }
            valueColor={isCharging ? ROLE_CHROME.ev.value : IDLE_CHROME.value}
          />
          {etaValue ? (
            <div className="shrink-0">
              <TrendRow label={etaLabel} value={etaValue} />
            </div>
          ) : chargeLimit != null ? (
            <div className="shrink-0">
              <TrendRow
                label="Limit"
                value={<Value value={Math.round(chargeLimit)} unit="%" />}
              />
            </div>
          ) : null}
        </div>
        {/* The armed limit: compact from 150px, the full sentence from 260px. */}
        {limitCompact && (
          <div
            className={`mt-1 truncate ${TILE_CAPTION} text-tile-ink-dim @[260px]:hidden`}
          >
            {limitCompact}
          </div>
        )}
        {limitText && (
          <div
            className={`mt-1 hidden truncate ${TILE_CAPTION} text-tile-ink-dim @[260px]:block`}
          >
            {limitText}
          </div>
        )}
      </div>
    </TileSurface>
  );
}
