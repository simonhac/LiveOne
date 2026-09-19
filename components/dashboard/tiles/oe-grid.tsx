"use client";

import GridSignalsCard from "@/components/GridSignalsCard";
import { oeGridSelection } from "@/lib/grid/latest";
import { nemRegionShortLabel } from "@/lib/vendors/openelectricity/region";
import type { TilePlugin, TileRenderProps } from "./types";

/**
 * The OpenElectricity grid-signals tile — bound to a member OE region device. Reads the live
 * price/emissions/renewables values from the device's `latest`; the region label comes from the
 * device's own `vendorSiteId` payload (no location derivation).
 *
 * Availability and rendering go through the SAME selector, `oeGridSelection`, which requires a real
 * NEM region rather than just the values — see its docstring for why that stopped being optional
 * once the OE points moved into the `bidi.grid.*` namespace Amber also publishes on.
 */
function OeGridTile({ data }: TileRenderProps) {
  const resolved = oeGridSelection(data);
  if (!resolved) return null;
  return (
    <GridSignalsCard
      regionLabel={nemRegionShortLabel(resolved.region)}
      values={resolved.values}
    />
  );
}

export const oeGridTile: TilePlugin = {
  kind: "tile",
  type: "oe-grid",
  isAvailable: ({ data }) => oeGridSelection(data) !== null,
  Render: OeGridTile,
};
