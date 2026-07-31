"use client";

/**
 * The generator-runs panel — self-fetches its device's timezone (the runs panel reads the temporal
 * navigator, which needs it), then renders GeneratorRunsCard. Device-bound: reads
 * `deviceSystemId ?? handle` (run periods are keyed by a member system_id, not the synthetic
 * area handle).
 */
import GeneratorRunsCard from "@/components/GeneratorRunsCard";
import type { CardPlugin, CardRenderProps } from "./types";
import { ChartSkeleton, subjectOf, useAreaDatum } from "./shared";

function AreaGeneratorRuns({ handle, deviceSystemId }: CardRenderProps) {
  const systemId = deviceSystemId ?? handle!;
  const { datum } = useAreaDatum(systemId);
  const tz = subjectOf(datum)?.timezoneOffsetMin;
  if (tz == null) {
    return <ChartSkeleton />;
  }
  return <GeneratorRunsCard systemId={systemId} timezoneOffsetMin={tz} />;
}

export const generatorRunsPlugin: CardPlugin = {
  kind: "card",
  type: "generator-runs",
  Render: AreaGeneratorRuns,
};
