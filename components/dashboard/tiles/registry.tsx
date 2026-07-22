"use client";

/**
 * The tile-view render registry — one plugin per `TileView`. The `satisfies` check makes this
 * exhaustive at compile time: adding a view to `TileView` (lib/dashboard/v3.ts) is a type error
 * until a plugin is registered here. Adding a tile = one module in this directory + one line below.
 */
import type { TileView } from "@/lib/dashboard/v3";
import type { TilePlugin } from "./types";
import { solarTile } from "./solar";
import { loadTile } from "./load";
import { batteryTile } from "./battery";
import { houseToGridTile } from "./house-to-grid";
import { amberTile } from "./amber";
import { evTile } from "./ev";
import { hotWaterTile } from "./hot-water";
import { oeGridTile } from "./oe-grid";
import { renewablesTile } from "./renewables";

export const TILE_RENDERERS = {
  solar: solarTile,
  load: loadTile,
  hotWater: hotWaterTile,
  battery: batteryTile,
  "house-to-grid": houseToGridTile,
  amber: amberTile,
  ev: evTile,
  renewables: renewablesTile,
  "oe-grid": oeGridTile,
} satisfies Record<TileView, TilePlugin>;
