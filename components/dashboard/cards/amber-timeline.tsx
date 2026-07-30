"use client";

/** The Amber prices/forecast timeline. */
import AmberCard from "@/components/AmberCard";
import type { CardPlugin, CardRenderProps } from "./types";
import { subjectOf, useAreaDatum } from "./shared";

function AreaAmberTimeline({ handle }: CardRenderProps) {
  const systemId = handle!;
  const { datum } = useAreaDatum(systemId);
  const subject = subjectOf(datum);
  return (
    <AmberCard
      systemId={systemId}
      timezoneOffsetMin={subject?.timezoneOffsetMin ?? 600}
      displayTimezone={subject?.displayTimezone}
    />
  );
}

export const amberTimelinePlugin: CardPlugin = {
  type: "amber-timeline",
  Render: AreaAmberTimeline,
};
