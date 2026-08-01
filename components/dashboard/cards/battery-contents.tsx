"use client";

/**
 * The live "Battery Contents" card — the inventory valuation of the energy currently in the
 * battery (usable kWh, total carbon + intensity, actual + opportunity cost, renewable %, export
 * value). The battery points are bound into the Area, so they surface in the section handle's
 * `dashboardDataQuery` `latest` map (read the handle, NOT a member device).
 */
import BatteryContentsCard from "@/components/BatteryContentsCard";
import { batteryContentsFromData } from "@/lib/battery/contents-latest";
import type { CardPlugin, CardRenderProps } from "./types";
import { CardSkeleton, useAreaDatum } from "./shared";
import { CARD_FOOTPRINTS } from "./footprints";

function AreaBatteryContents({ handle }: CardRenderProps) {
  const { data, isLoading } = useAreaDatum(handle!);
  // Same reasoning as `amber-now`: `BatteryContentsCard` collapses on a null valuation and cannot
  // distinguish "not fetched yet" from "no battery bound to this area". `isLoading` can.
  if (isLoading)
    return <CardSkeleton height={CARD_FOOTPRINTS["battery-contents"]} />;
  return <BatteryContentsCard values={batteryContentsFromData(data ?? null)} />;
}

export const batteryContentsPlugin: CardPlugin = {
  kind: "card",
  type: "battery-contents",
  footprint: () => CARD_FOOTPRINTS["battery-contents"],
  Render: AreaBatteryContents,
};
