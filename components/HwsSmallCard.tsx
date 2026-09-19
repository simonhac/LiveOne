"use client";

import { useId } from "react";
import { Thermometer } from "lucide-react";
import Tile from "@/components/Tile";
import DirectionChip from "@/components/ui/direction-chip";
import { ROLE_CHROME } from "@/lib/role-chrome";
import { sparklineGeometry } from "@/lib/charts/sparkline";
import { TILE_LABEL, TILE_TICK } from "@/lib/tile-style";

/**
 * Compact "Hot Water" mini-card: the current modelled faucet temperature (°C, orange) from the
 * `load.hws/temperature` point in `latest`, plus a 24h line. Purely presentational — the value,
 * measurement time, `sparkValues` (the 24h history series) and its time ticks are passed in from the
 * hot-water tile plugin (components/dashboard/tiles/hot-water.tsx), which orchestrates the fetch.
 *
 * `sparkValues` is POSITIONAL: one slot per interval of the requested window, null where there is no
 * reading. Do not compact it before passing it in — see `lib/charts/sparkline.ts` for why a
 * null-stripped array renders as a lie.
 */
export default function HwsSmallCard({
  faucetC,
  sparkValues,
  sparkTicks = [],
  measurementTime,
  heating,
  staleThresholdSeconds,
}: {
  faucetC: number | null;
  sparkValues: (number | null)[];
  /** Positional (0..1) time-axis ticks — `dayTicks` in lib/charts/tile-bars.ts. */
  sparkTicks?: { at: number; label: string }[];
  measurementTime?: Date;
  heating: boolean;
  staleThresholdSeconds: number;
}) {
  if (faucetC == null) return null;

  return (
    <Tile
      title="Hot Water"
      icon={<Thermometer />}
      tone={ROLE_CHROME.hotWater.value}
      label="Now"
      value={faucetC.toFixed(1)}
      unit="°C"
      valueColor={ROLE_CHROME.hotWater.value}
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={measurementTime}
      extraInfo={
        heating ? (
          <span className="mt-1 inline-flex items-center gap-2">
            <DirectionChip direction="up" color={ROLE_CHROME.hotWater.rgb} />
            <span className={TILE_LABEL}>Heating</span>
          </span>
        ) : undefined
      }
      extra={<Sparkline values={sparkValues} ticks={sparkTicks} />}
    />
  );
}

const SPARK_W = 100;
const SPARK_H = 32;

/**
 * The 24h temperature line: a 2px round-capped stroke over an orange→transparent fill, on the same
 * hairlines and four time labels the bar tiles use. Geometry — including where the line breaks and
 * how far right it reaches — lives in `sparklineGeometry`; this only paints it.
 */
function Sparkline({
  values,
  ticks,
}: {
  values: (number | null)[];
  ticks: { at: number; label: string }[];
}) {
  const gradientId = useId().replace(/:/g, "");
  const { segments } = sparklineGeometry(values, SPARK_W, SPARK_H);
  if (segments.length === 0) return null;
  const colour = ROLE_CHROME.hotWater.rgb;
  return (
    <div className="mt-auto w-full">
      <div className="relative h-10 w-full">
        {ticks.map((t) => (
          <span
            key={t.at}
            className="absolute inset-y-0 border-l border-white/25"
            style={{ left: `${t.at * 100}%` }}
          />
        ))}
        <svg
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
          aria-hidden
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colour} stopOpacity={0.35} />
              <stop offset="100%" stopColor={colour} stopOpacity={0} />
            </linearGradient>
          </defs>
          {segments.map((points, i) => {
            const first = points.split(" ")[0].split(",")[0];
            const last = points.split(" ").at(-1)!.split(",")[0];
            return (
              <g key={i}>
                <polygon
                  points={`${first},${SPARK_H} ${points} ${last},${SPARK_H}`}
                  fill={`url(#${gradientId})`}
                />
                <polyline
                  points={points}
                  fill="none"
                  stroke={colour}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            );
          })}
        </svg>
      </div>
      {ticks.length > 0 && (
        <div className="relative h-3.5 w-full">
          {ticks.map((t) => (
            <span
              key={t.at}
              className={`absolute top-0 h-full whitespace-nowrap border-l border-white/25 pl-[3px] pt-px ${TILE_TICK}`}
              style={{ left: `${t.at * 100}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
