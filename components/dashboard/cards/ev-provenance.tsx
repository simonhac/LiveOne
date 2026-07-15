"use client";

/**
 * The per-load provenance report (the EV by default) over a trailing window of completed days.
 * Reads the section handle's timezone, fetches the `source=modern` flow matrix, and reduces the
 * metric legs client-side into "$X, Y% renewable, Z g/kWh, N% estimated" + the source split.
 */
import { useQuery } from "@tanstack/react-query";
import LoadProvenanceCard from "@/components/LoadProvenanceCard";
import { flowMatrixQuery } from "@/lib/queries/flowMatrix";
import { reduceLoadProvenance } from "@/lib/energy-flow-matrix";
import type { CardPlugin, CardRenderProps } from "./types";
import { useAreaDatum } from "./shared";

function AreaLoadProvenance({ handle }: CardRenderProps) {
  const systemId = handle!;
  const { datum, paused } = useAreaDatum(systemId);
  const tz = datum?.system?.timezoneOffsetMin;

  // Trailing 30 COMPLETED local days (the attr rollup excludes today-so-far).
  const offsetMs = (tz ?? 600) * 60_000;
  const todayLocal = new Date(Date.now() + offsetMs);
  const end = new Date(todayLocal);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(todayLocal);
  start.setUTCDate(start.getUTCDate() - 30);
  const startYMD = start.toISOString().slice(0, 10);
  const endYMD = end.toISOString().slice(0, 10);

  const { data: fm, isLoading } = useQuery(
    flowMatrixQuery({
      systemId,
      startYMD,
      endYMD,
      timezoneOffsetMin: tz ?? 600,
      source: "modern",
      enabled: tz != null && !paused,
    }),
  );
  const summary = fm ? reduceLoadProvenance(fm, "load.ev") : null;
  return (
    <LoadProvenanceCard
      summary={summary}
      periodLabel="last 30 days"
      title="EV Charging"
      loading={tz == null || isLoading}
    />
  );
}

export const evProvenancePlugin: CardPlugin = {
  type: "ev-provenance",
  Render: AreaLoadProvenance,
};
