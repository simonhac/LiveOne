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
  // `device` only: the NEM region is an OpenElectricity DEVICE's `vendorSiteId` ("NSW1"/"VIC1"). An
  // area has no vendor site (it used to carry the `"area:{handle}"` sentinel, which `isNemRegion`
  // rejected anyway), so this tile is only ever meaningful on a device-bound section.
  const siteId = (data as { device?: { vendorSiteId?: string | null } } | null)
    ?.device?.vendorSiteId;
  const region = siteId && isNemRegion(siteId) ? siteId : null;
  return (
    <GridSignalsCard
      regionLabel={region ? nemRegionShortLabel(region) : ""}
      values={values}
    />
  );
}

export const oeGridTile: TilePlugin = {
  kind: "tile",
  type: "oe-grid",
  isAvailable: ({ data }) => gridLatestFromData(data) !== null,
  Render: OeGridTile,
};
