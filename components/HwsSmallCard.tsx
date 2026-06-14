"use client";

import { Thermometer } from "lucide-react";
import PowerCard from "@/components/PowerCard";

const HWS_COLOR = "rgb(251, 146, 60)"; // CHART_COLORS.hotWater (orange-400)

/**
 * Compact "Hot Water" mini-card: the current modelled faucet temperature (°C, orange) from the
 * `load.hws/temperature` point in `latest`, plus a 24h sparkline. Purely presentational — both the
 * value/measurement time and the `sparkValues` (the 24h history series) are passed in from
 * usePowerCardNodes, which orchestrates the generic /api/history fetch. No data fetching here.
 */
export default function HwsSmallCard({
  faucetC,
  sparkValues,
  measurementTime,
  heating,
  staleThresholdSeconds,
}: {
  faucetC: number | null;
  sparkValues: number[];
  measurementTime?: Date;
  heating: boolean;
  staleThresholdSeconds: number;
}) {
  if (faucetC == null) return null;

  return (
    <PowerCard
      title="Hot Water"
      value={faucetC.toFixed(1)}
      unit="°C"
      icon={<Thermometer className="w-6 h-6" />}
      iconColor="text-orange-400"
      bgColor="bg-orange-900/20"
      borderColor="border-orange-700"
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={measurementTime}
      extra={
        <div className="space-y-0.5">
          {sparkValues.length >= 2 && <Sparkline values={sparkValues} />}
          {heating && <div className="text-xs text-orange-300">Heating</div>}
        </div>
      }
    />
  );
}

/** Minimal inline SVG sparkline (no charting dep), scaled to the value range over the window. */
function Sparkline({ values }: { values: number[] }) {
  const W = 100;
  const H = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((v - min) / span) * H;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-5"
      aria-hidden
    >
      <polyline
        points={pts}
        fill="none"
        stroke={HWS_COLOR}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
