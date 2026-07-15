"use client";

/**
 * The device-metrics panel — a grid/table of the device's raw numeric points (no role). Self-
 * fetches the system only to derive the vendor-appropriate stale threshold; DeviceMetricsCard
 * owns its own readings query (and its loading/empty states), so no skeleton gate is needed here.
 * Device-bound: reads `card.deviceSystemId ?? handle`.
 */
import DeviceMetricsCard from "@/components/DeviceMetricsCard";
import type { CardPlugin, CardRenderProps } from "./types";
import { staleThreshold, useAreaDatum } from "./shared";

function AreaDeviceMetrics({ card, handle }: CardRenderProps) {
  const systemId = card.deviceSystemId ?? handle!;
  const { datum } = useAreaDatum(systemId);
  const system = datum?.system;
  return (
    <DeviceMetricsCard
      systemId={systemId}
      staleThresholdSeconds={staleThreshold(
        system?.vendorType ?? "",
        system?.config?.updateCadenceSeconds,
      )}
      variant={card.variant}
    />
  );
}

export const deviceMetricsPlugin: CardPlugin = {
  type: "device-metrics",
  Render: AreaDeviceMetrics,
};
