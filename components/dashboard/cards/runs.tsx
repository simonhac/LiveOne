"use client";

/**
 * The runs panel — self-fetches its device's timezone (the runs panel reads the temporal navigator,
 * which needs it), then renders RunsCard for whichever role the node's config names.
 *
 * Device-bound: reads `deviceSystemId ?? handle`, because run periods are keyed by a MEMBER
 * system_id and never by the synthetic area handle. On a multi-device area the fallback to `handle`
 * resolves no detector, so such a card must carry `device: dv_…` — see `runsConfigSchema`.
 */
import RunsCard from "@/components/RunsCard";
import {
  runsConfigSchema,
  type RunsCardConfig,
} from "@/lib/dashboard/card-types";
import { runningFromLatest } from "@/lib/generator/running";
import type { CardPlugin, CardRenderProps } from "./types";
import { CardSkeleton, subjectOf, useAreaDatum } from "./shared";
import { CARD_FOOTPRINTS } from "./footprints";

/**
 * Per-role copy. The role decides the noun, and the noun has to be right: a generator has *runs*,
 * an EV has *charge sessions*, and calling either by the other's name reads as a bug.
 */
const COPY: Record<
  RunsCardConfig["role"],
  { title: string; empty: string; active: string; noun: string }
> = {
  generator: {
    title: "Generator runs",
    empty: "No generator runs in this period",
    active: "running",
    noun: "run",
  },
  ev: {
    title: "EV charging",
    empty: "No charge sessions in this period",
    active: "charging",
    noun: "session",
  },
};

function AreaRuns({ node, handle, deviceSystemId }: CardRenderProps) {
  const systemId = deviceSystemId ?? handle!;
  const { datum } = useAreaDatum(systemId);
  const tz = subjectOf(datum)?.timezoneOffsetMin;
  // A doc written before the rename carries no config; the schema's default makes that the
  // generator, which is exactly what such a doc used to mean.
  const parsed = runsConfigSchema.safeParse(node.config ?? {});
  const role = parsed.success ? parsed.data.role : "generator";
  // The live on/off flag rides on the datum this card already fetches for its timezone, so reading
  // it costs no extra request. It beats the run-periods response's open-period flag to the badge
  // (that query is on a 60s staleTime and a coarser window), and falls through to it when the
  // derived `<stem>/running` point isn't in the latest map yet.
  const active = runningFromLatest(datum?.latest, role);
  if (tz == null) {
    return <CardSkeleton height={CARD_FOOTPRINTS.runs} />;
  }
  return (
    <RunsCard
      systemId={systemId}
      timezoneOffsetMin={tz}
      role={role}
      title={COPY[role].title}
      emptyText={COPY[role].empty}
      activeLabel={COPY[role].active}
      noun={COPY[role].noun}
      runningOverride={active}
    />
  );
}

export const runsPlugin: CardPlugin = {
  kind: "card",
  type: "runs",
  footprint: () => CARD_FOOTPRINTS.runs,
  Render: AreaRuns,
};
