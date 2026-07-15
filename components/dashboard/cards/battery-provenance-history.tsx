"use client";

/**
 * The battery-provenance history panel: 365 days of the learn/fold daily state
 * (`battery_provenance_daily`). The rows are keyed by the BATTERY AREA's uuid, which is resolved
 * two ways: on the helper device's /device view (no area-of-one — the section areaId is the
 * `device-` sentinel) the parent area is parsed from the helper's `helper:area:<uuid>` vendorSiteId;
 * on a real area dashboard the section's areaId is used as-is.
 */
import BatteryProvenancePanel from "@/components/battery-provenance/BatteryProvenancePanel";
import { parentAreaIdFromHelperSiteId } from "@/lib/areas/helper-site-id";
import type { CardPlugin, CardRenderProps } from "./types";
import { ChartSkeleton, useAreaDatum } from "./shared";

function AreaBatteryProvenanceHistory({ section, handle }: CardRenderProps) {
  const { datum } = useAreaDatum(handle!);
  const system = datum?.system;
  if (!system) return <ChartSkeleton />;

  let areaId: string | null;
  if (system.vendorType === "helper") {
    areaId = parentAreaIdFromHelperSiteId(system.vendorSiteId ?? "");
  } else if (!section.areaId.startsWith("device-")) {
    areaId = section.areaId;
  } else {
    areaId = null;
  }
  if (!areaId) return null;

  return (
    <BatteryProvenancePanel
      areaId={areaId}
      timezoneOffsetMin={system.timezoneOffsetMin}
    />
  );
}

export const batteryProvenanceHistoryPlugin: CardPlugin = {
  type: "battery-provenance-history",
  Render: AreaBatteryProvenanceHistory,
};
