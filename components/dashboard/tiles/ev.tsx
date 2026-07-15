"use client";

import TeslaSmallCard from "@/components/TeslaSmallCard";
import type { TilePlugin } from "./types";
import { getPointValue } from "./shared";

export const evTile: TilePlugin = {
  view: "ev",
  isAvailable: ({ latest }) => getPointValue(latest, "ev.battery/soc") !== null,
  Render: ({ latest, systemId, canControl }) => (
    <TeslaSmallCard
      latest={latest}
      systemId={systemId}
      canControl={canControl}
    />
  ),
};
