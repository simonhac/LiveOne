"use client";

import AmberSmallCard from "@/components/AmberSmallCard";
import type { TilePlugin } from "./types";
import { getPointValue } from "./shared";

export const amberTile: TilePlugin = {
  kind: "tile",
  type: "amber",
  isAvailable: ({ latest }) =>
    getPointValue(latest, "bidi.grid.import/rate") !== null,
  // AmberSmallCard sizes itself from its OWN container width, stepping up at 180px — a flat tile
  // placeholder would be 70px short of it in a wide column and drag the `auto-rows-fr` row with it.
  skeletonClass: "@container @[180px]:min-h-[180px] min-w-[66px] self-stretch",
  Render: ({ latest }) => <AmberSmallCard latest={latest} />,
};
