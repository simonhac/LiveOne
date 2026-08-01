"use client";

import TeslaSmallCard from "@/components/TeslaSmallCard";
import type { TilePlugin } from "./types";
import { getPointValue } from "./shared";

export const evTile: TilePlugin = {
  kind: "tile",
  type: "ev",
  isAvailable: ({ latest }) => getPointValue(latest, "ev.battery/soc") !== null,
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
