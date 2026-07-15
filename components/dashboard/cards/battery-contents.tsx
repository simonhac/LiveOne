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
import { useAreaDatum } from "./shared";

function AreaBatteryContents({ handle }: CardRenderProps) {
  const { data } = useAreaDatum(handle!);
  return <BatteryContentsCard values={batteryContentsFromData(data ?? null)} />;
}

export const batteryContentsPlugin: CardPlugin = {
  type: "battery-contents",
  Render: AreaBatteryContents,
};
