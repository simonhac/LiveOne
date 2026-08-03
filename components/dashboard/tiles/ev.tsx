"use client";

import TeslaSmallCard from "@/components/TeslaSmallCard";
import type { TilePlugin } from "./types";
import { getPointValue } from "./shared";
import { TESLA_CHARGE_CONTROL_PATHS } from "@/lib/control/point-ref";

export const evTile: TilePlugin = {
  kind: "tile",
  type: "ev",
  isAvailable: ({ latest }) => getPointValue(latest, "ev.battery/soc") !== null,
  // The cog commands THESE points, so ownership of THEIR device is what gates it — see
  // `datumCanControlPoint`. Availability is still keyed on `ev.battery/soc`, which is the tile's
  // data, not its controls.
  controlPaths: TESLA_CHARGE_CONTROL_PATHS,
  // Same container-query box model as AmberSmallCard — see the note on `amberTile`.
  skeletonClass: "@container @[180px]:min-h-[180px] min-w-[66px] self-stretch",
  Render: ({ latest, systemId, canControl }) => (
    <TeslaSmallCard
      latest={latest}
      systemId={systemId}
      canControl={canControl}
    />
  ),
};
