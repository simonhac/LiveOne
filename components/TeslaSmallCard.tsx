"use client";

import { useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Value from "@/components/ui/value";
import ProgressRing from "@/components/ui/progress-ring";
import { ChevronRight, ChevronsRight, Settings } from "lucide-react";
import TileSurface from "@/components/ui/tile-surface";
import {
  TILE_CAPTION,
  TILE_CHIP,
  TILE_RING,
  TILE_RING_VALUE,
} from "@/lib/tile-style";
import { ROLE_CHROME } from "@/lib/role-chrome";
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
 * | Width    | Height | Ring D | Mark   | Cog    | Caption                          |
 * |----------|--------|--------|--------|--------|----------------------------------|
 * | 66px min | 110px  | 64     | Hidden | Hidden | state                            |
 * | 90px+    | 110px  | 64     | 16px   | Hidden | state                            |
 * | 120px+   | 110px  | 72     | 16px   | 28px   | state                            |
 * | 180px+   | 180px  | 108    | 20px   | 28px   | state · armed limit (compact)    |
 * | 220px+   | 180px  | 108    | 20px   | 28px   | state · kW, then the ETA         |
 * | 260px+   | 180px  | 108    | 20px   | 28px   | … and the armed limit in full    |
 */
export default function TeslaSmallCard({
  latest,
  systemId,
  canControl,
  areaId,
}: TeslaSmallCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  const [showDebug, setShowDebug] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);

  const showControls = canControl && systemId != null;

  // Armed charge limits for this area. Gated on `showControls` twice over: it spares viewers a
  // pointless request, and the route is area-OWNER gated, so firing it for a non-owner would earn
  // a guaranteed 403 that React Query would then retry.
  const limitsQuery = useQuery({
    ...chargeAutomationsQuery(areaId),
    enabled: !!areaId && !!showControls,
  });

  // Show debug indicator only when ?debug is in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setShowDebug(params.has("debug"));
  }, []);

  // Track container size for debugging
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const paddingX =
      parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const paddingY =
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const borderX =
      parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const borderY =
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    setContainerSize({
      width: Math.round(rect.width - paddingX - borderX),
      height: Math.round(rect.height - paddingY - borderY),
    });
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  // Charging detail: power fuses onto the state line, the ETA gets its own.
  const powerText =
    isCharging && chargePower !== null ? `${chargePower} kW` : null;
  const etaText =
    isCharging && timeToFull
      ? `${formatTimeRemaining(timeToFull)} to ${chargeLimit ? `${Math.round(chargeLimit)}%` : "full"}`
      : null;

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
      rootRef={containerRef}
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
      {/* DEBUG: Container size indicator */}
      {/* `bg-red-500` stays literal: a ?debug-only badge, not a `danger` state. */}
      {showDebug && (
        <div className="absolute top-0 right-0 bg-red-500 text-ink text-[10px] px-1 rounded-bl z-50">
          {containerSize.width}w {containerSize.height}h
        </div>
      )}

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

      {/* Status in the caption slot under the ring. The charging detail (kW, ETA) waits for a card
          wide enough to hold it on one line. */}
      <div className={`mt-1 text-center ${TILE_CAPTION}`}>
        <div className="truncate">
          {statusWords.join(" ")}
          {powerText && (
            <span className="hidden @[220px]:inline"> · {powerText}</span>
          )}
        </div>
        {etaText && (
          <div className="hidden @[220px]:block truncate">{etaText}</div>
        )}
        {/* The armed limit: compact from 180px, the full sentence from 260px like `etaText`. */}
        {limitCompact && (
          <div className="hidden @[180px]:block @[260px]:hidden truncate text-tile-ink-dim">
            {limitCompact}
          </div>
        )}
        {limitText && (
          <div className="hidden @[260px]:block truncate text-tile-ink-dim">
            {limitText}
          </div>
        )}
      </div>
    </TileSurface>
  );
}
