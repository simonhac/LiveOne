"use client";

/**
 * The battery-provenance history panel: 365 days of the learn/fold daily state
 * (`battery_provenance_daily`). The rows are keyed by the BATTERY AREA, which is resolved two ways:
 * on the helper device's /device view (no area-of-one — the section areaId is the `device-` sentinel)
 * the parent area is parsed from the helper's `helper:area:<uuid>` vendorSiteId (raw uuid, below the
 * seam — the helper device identity, not a public area id); on a real area dashboard the section's
 * areaId is used as-is (already `ar_`, the read-normalized descriptor). Both are normalized to `ar_`
 * before reaching the panel, so no raw uuid reaches the `/api/areas/*` wire.
 */
import BatteryProvenancePanel from "@/components/battery-provenance/BatteryProvenancePanel";
import { parentAreaIdFromHelperSiteId } from "@/lib/areas/helper-site-id";
import { areaRefToArId } from "@/lib/areas/ref";
import type { CardPlugin, CardRenderProps } from "./types";
import { ChartSkeleton, subjectOf, useAreaDatum } from "./shared";

function AreaBatteryProvenanceHistory({ section, handle }: CardRenderProps) {
  const { datum } = useAreaDatum(handle!);
  const device = subjectOf(datum);
  if (!device) return <ChartSkeleton />;

  let areaRef: string | null;
  if (device.vendorType === "helper") {
    areaRef = parentAreaIdFromHelperSiteId(device.vendorSiteId ?? "");
  } else if (!section.areaId.startsWith("device-")) {
    areaRef = section.areaId;
  } else {
    areaRef = null;
  }
  const areaId = areaRef ? areaRefToArId(areaRef) : null;
  if (!areaId) return null;

  return (
    <BatteryProvenancePanel
      areaId={areaId}
      timezoneOffsetMin={device.timezoneOffsetMin}
    />
  );
}

export const batteryProvenanceHistoryPlugin: CardPlugin = {
  type: "battery-provenance-history",
  Render: AreaBatteryProvenanceHistory,
};
