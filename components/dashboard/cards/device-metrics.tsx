"use client";

/**
 * The device-metrics panel — a grid/table of the device's raw numeric points (no role). Self-
 * fetches the device only to derive the vendor-appropriate stale threshold; DeviceMetricsCard
 * owns its own readings query (and its loading/empty states), so no skeleton gate is needed here.
 * Device-bound: reads `deviceSystemId ?? handle`.
 */
import DeviceMetricsCard from "@/components/DeviceMetricsCard";
import type { DeviceMetricsConfig } from "@/lib/dashboard/card-types";
import type { CardPlugin, CardRenderProps } from "./types";
import { staleThreshold, subjectOf, useAreaDatum } from "./shared";

function AreaDeviceMetrics({ node, handle, deviceSystemId }: CardRenderProps) {
  const systemId = deviceSystemId ?? handle!;
  const { datum } = useAreaDatum(systemId);
  const device = subjectOf(datum);
  const config = node.config as DeviceMetricsConfig | undefined;
  return (
    <DeviceMetricsCard
      systemId={systemId}
      staleThresholdSeconds={staleThreshold(
        device?.vendorType ?? "",
        device?.config?.updateCadenceSeconds,
      )}
      variant={config?.variant}
    />
  );
}

export const deviceMetricsPlugin: CardPlugin = {
  kind: "card",
  type: "device-metrics",
  Render: AreaDeviceMetrics,
};
