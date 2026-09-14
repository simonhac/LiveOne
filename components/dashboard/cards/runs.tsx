"use client";

/**
 * The runs panel — self-fetches its device's timezone (the runs panel reads the temporal navigator,
 * which needs it), then renders RunsCard for whichever role the node's config names.
 *
 * Device-bound: reads `deviceSystemId ?? handle`. The pin is OPTIONAL — since migration 0063 a
 * detector is reachable from every device it draws a source point from, so an unpinned card on a
 * multi-device area resolves through the member set (`getRunDetectorForDevices`), which is why
 * `lib/capabilities/strategy.ts` emits these unpinned. Pin a `device: dv_…` to name WHICH detector
 * when an area has more than one for a role; the resolver otherwise takes the first.
 *
 * 🛑 The pin used to be described as mandatory, and it was the pin that broke this card: a `dv_…` is
 * collapsed to that device's integer handle here, and a handle can name both a device and an area.
 * The resolver behind `/api/device/{handle}/run-periods` resolved the area leg and found no detector,
 * so this panel reported "no charge sessions" on a page whose chart was bracketing those very
 * sessions. Fixed at the resolver (`memberDevices` is device-first now); see
 * `docs/plans/exact-resolution-or-refuse.md`.
 */
import Panel from "@/components/ui/panel";
import RunsCard from "@/components/RunsCard";
import {
  resolveRunsConfig,
  type RunsCardConfig,
} from "@/lib/dashboard/card-types";
import { runningFromLatest } from "@/lib/generator/running";
import type { CardPlugin, CardRenderProps } from "./types";
import { CardSkeleton, subjectOf, useAreaDatum } from "./shared";
import { CARD_FOOTPRINTS } from "./footprints";

/**
 * Per-role copy. The role decides the noun, and the noun has to be right: a generator has *runs*,
 * an EV has *charge sessions*, and calling either by the other's name reads as a bug.
 *
 * `empty` and `untracked` are deliberately different sentences — see `RunsCard`'s `untrackedText`.
 */
const COPY: Record<
  RunsCardConfig["role"],
  {
    title: string;
    empty: string;
    untracked: string;
    active: string;
    noun: string;
  }
> = {
  generator: {
    title: "Generator runs",
    empty: "No generator runs in this period",
    untracked: "No generator run detector for this device",
    active: "running",
    noun: "run",
  },
  ev: {
    title: "EV charging",
    empty: "No charge sessions in this period",
    untracked: "No EV charge detector for this device",
    active: "charging",
    noun: "session",
  },
};

function ConfigNotice() {
  return (
    <Panel className="px-4 py-3 text-sm text-gray-400" padded={false}>
      This runs card is misconfigured.
    </Panel>
  );
}

function AreaRuns({ node, handle, deviceSystemId }: CardRenderProps) {
  const systemId = deviceSystemId ?? handle!;
  const { datum } = useAreaDatum(systemId);
  const tz = subjectOf(datum)?.timezoneOffsetMin;
  // A doc written before the rename carries no config; the schema's default makes that the
  // generator, which is exactly what such a doc used to mean. A doc whose config is PRESENT and
  // unreadable gets a notice instead — never a silent fall back to the generator, which would render
  // a whole EV card under the wrong role. See `resolveRunsConfig`.
  const config = resolveRunsConfig(node.config);
  if (!config) return <ConfigNotice />;
  if (tz == null) {
    return <CardSkeleton height={CARD_FOOTPRINTS.runs} />;
  }
  const copy = COPY[config.role];
  // The live on/off flag rides on the datum this card already fetches for its timezone, so reading
  // it costs no extra request. It beats the run-periods response's open-period flag to the badge
  // (that query is on a 60s staleTime and a coarser window), and falls through to it when the
  // derived `<stem>/running` point isn't in the latest map yet. Not a hook, so it sits below the
  // guards rather than forcing a role on a card that could not read one.
  const active = runningFromLatest(datum?.latest, config.role);
  return (
    <RunsCard
      systemId={systemId}
      timezoneOffsetMin={tz}
      role={config.role}
      title={copy.title}
      emptyText={copy.empty}
      untrackedText={copy.untracked}
      activeLabel={copy.active}
      noun={copy.noun}
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
