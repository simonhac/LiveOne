"use client";

import AmberSmallCard from "@/components/AmberSmallCard";
import type { TilePlugin } from "./types";
import { getPointValue } from "./shared";

export const amberTile: TilePlugin = {
  kind: "tile",
  type: "amber",
  isAvailable: ({ latest }) =>
    getPointValue(latest, "bidi.grid.import/rate") !== null,
  Render: ({ latest }) => <AmberSmallCard latest={latest} />,
};
