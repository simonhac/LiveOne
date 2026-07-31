"use client";

/**
 * The battery-provenance history panel: 365 days of the learn/fold daily state
 * (`battery_provenance_daily`). The rows are keyed by the BATTERY AREA, which is resolved two ways:
 * on the helper device's /device view the parent area is parsed from the helper's
 * `helper:area:<uuid>` vendorSiteId (raw uuid, below the seam — the helper device identity, not a
 * public area id); on a real area dashboard the node's inherited `context.area` is used as-is
 * (already `ar_`, §8.1). Both are normalized to `ar_` before reaching the panel, so no raw uuid
 * reaches the `/api/areas/*` wire.
 *
 * 🛑 The `device-` SENTINEL BRANCH IS GONE (config-v4 Phase 14 stage 9). Its only producer was
 * `/device/{id}`, which synthesised `device-{id}` as a stand-in `section.areaId` when a device had no
 * Area; that page now renders a DEVICE-bound v4 document with no area envelope at all, so this card
 * sees `context.area === undefined` — the same "no area" outcome the sentinel branch produced, so
 * the removal is behaviour-preserving as well as producer-less. (Independently: every device on both
 * environments now has an area-of-one, so the sentinel had already stopped being reachable.)
 */
import BatteryProvenancePanel from "@/components/battery-provenance/BatteryProvenancePanel";
import { parentAreaIdFromHelperSiteId } from "@/lib/areas/helper-site-id";
import { areaRefToArId } from "@/lib/areas/ref";
import type { CardPlugin, CardRenderProps } from "./types";
import { ChartSkeleton, subjectOf, useAreaDatum } from "./shared";

function AreaBatteryProvenanceHistory({ context, handle }: CardRenderProps) {
  const { datum } = useAreaDatum(handle!);
  const device = subjectOf(datum);
  if (!device) return <ChartSkeleton />;

  const areaRef =
    device.vendorType === "helper"
      ? parentAreaIdFromHelperSiteId(device.vendorSiteId ?? "")
      : context.area;
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
