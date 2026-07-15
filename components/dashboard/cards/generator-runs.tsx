"use client";

/**
 * The generator-runs panel — self-fetches its system's timezone (the runs panel reads the temporal
 * navigator, which needs it), then renders GeneratorRunsCard. Device-bound: reads
 * `card.deviceSystemId ?? handle` (run periods are keyed by a member system_id, not the synthetic
 * area handle).
 */
import GeneratorRunsCard from "@/components/GeneratorRunsCard";
import type { CardPlugin, CardRenderProps } from "./types";
import { ChartSkeleton, useAreaDatum } from "./shared";

function AreaGeneratorRuns({ card, handle }: CardRenderProps) {
  const systemId = card.deviceSystemId ?? handle!;
  const { datum } = useAreaDatum(systemId);
  const tz = datum?.system?.timezoneOffsetMin;
  if (tz == null) {
    return <ChartSkeleton />;
  }
  return <GeneratorRunsCard systemId={systemId} timezoneOffsetMin={tz} />;
}

export const generatorRunsPlugin: CardPlugin = {
  type: "generator-runs",
  Render: AreaGeneratorRuns,
};
