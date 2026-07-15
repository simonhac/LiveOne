"use client";

/** The Amber prices/forecast timeline. */
import AmberCard from "@/components/AmberCard";
import type { CardPlugin, CardRenderProps } from "./types";
import { useAreaDatum } from "./shared";

function AreaAmberTimeline({ handle }: CardRenderProps) {
  const systemId = handle!;
  const { datum } = useAreaDatum(systemId);
  return (
    <AmberCard
      systemId={systemId}
      timezoneOffsetMin={datum?.system?.timezoneOffsetMin ?? 600}
      displayTimezone={datum?.system?.displayTimezone}
    />
  );
}

export const amberTimelinePlugin: CardPlugin = {
  type: "amber-timeline",
  Render: AreaAmberTimeline,
};
