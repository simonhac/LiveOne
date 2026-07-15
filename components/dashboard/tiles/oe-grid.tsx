"use client";

import GridSignalsCard from "@/components/GridSignalsCard";
import { gridLatestFromData } from "@/lib/grid/latest";
import { nemRegionShortLabel } from "@/lib/vendors/openelectricity/region";
import { isNemRegion } from "@/lib/vendors/openelectricity/types";
import type { TilePlugin, TileRenderProps } from "./types";

/**
 * The OpenElectricity grid-signals tile — bound to a member OE region device. Reads the live
 * price/emissions/renewables values from the device's `latest`; the region label comes from the
 * device's own `vendorSiteId` payload (no location derivation).
 */
function OeGridTile({ data }: TileRenderProps) {
  const values = gridLatestFromData(data);
  if (!values) return null;
  const siteId = (data as { system?: { vendorSiteId?: string | null } } | null)
    ?.system?.vendorSiteId;
  const region = siteId && isNemRegion(siteId) ? siteId : null;
  return (
    <GridSignalsCard
      regionLabel={region ? nemRegionShortLabel(region) : ""}
      values={values}
    />
  );
}

export const oeGridTile: TilePlugin = {
  view: "oe-grid",
  isAvailable: ({ data }) => gridLatestFromData(data) !== null,
  Render: OeGridTile,
};
