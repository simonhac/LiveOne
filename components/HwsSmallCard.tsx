"use client";

import { Thermometer } from "lucide-react";
import Tile from "@/components/Tile";
import { CHART_COLORS } from "@/lib/chart-colors";
import { ROLE_CHROME } from "@/lib/role-chrome";
import { sparklineGeometry } from "@/lib/charts/sparkline";

/**
 * Compact "Hot Water" mini-card: the current modelled faucet temperature (°C, orange) from the
 * `load.hws/temperature` point in `latest`, plus a 24h sparkline. Purely presentational — both the
 * value/measurement time and the `sparkValues` (the 24h history series) are passed in from the
 * hot-water tile plugin (components/dashboard/tiles/hot-water.tsx), which orchestrates the generic
 * /api/history fetch. No data fetching here.
 *
 * `sparkValues` is POSITIONAL: one slot per interval of the requested window, null where there is no
 * reading. Do not compact it before passing it in — see `lib/charts/sparkline.ts` for why a
 * null-stripped array renders as a lie.
 */
export default function HwsSmallCard({
  faucetC,
  sparkValues,
  measurementTime,
  heating,
  staleThresholdSeconds,
}: {
  faucetC: number | null;
  sparkValues: (number | null)[];
  measurementTime?: Date;
  heating: boolean;
  staleThresholdSeconds: number;
}) {
  if (faucetC == null) return null;

  return (
    <Tile
      title="Hot Water"
      value={faucetC.toFixed(1)}
      unit="°C"
      icon={<Thermometer className="w-6 h-6" />}
      iconColor={ROLE_CHROME.hotWater.icon}
      bgColor={ROLE_CHROME.hotWater.tint}
      borderColor={ROLE_CHROME.hotWater.border}
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={measurementTime}
      extra={
        <div className="space-y-0.5">
          <Sparkline values={sparkValues} />
          {heating && <div className="text-xs text-orange-300">Heating</div>}
        </div>
      }
    />
  );
}

const SPARK_W = 100;
const SPARK_H = 24;

/**
 * Minimal inline SVG sparkline (no charting dep). Geometry — including where the line breaks and how
 * far right it reaches — lives in `sparklineGeometry`; this only paints it.
 */
function Sparkline({ values }: { values: (number | null)[] }) {
  const { segments } = sparklineGeometry(values, SPARK_W, SPARK_H);
  if (segments.length === 0) return null;
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className="w-full h-5"
      aria-hidden
    >
      {segments.map((points, i) => (
        <polyline
          key={i}
          points={points}
          fill="none"
          stroke={CHART_COLORS.hotWater}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
