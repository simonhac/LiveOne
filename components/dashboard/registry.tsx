"use client";

/**
 * THE node render registry — one plugin per `KnownCardType`, tiles and cards together.
 *
 * §8.1 unified the card and tile primitives: a v4 `card` node is the ONLY leaf, and a tile is just a
 * small card. This module is the render-side consequence of that (config-v4 Phase 14 stage 7): the
 * two registries it replaces (`cards/registry.tsx` + `tiles/registry.tsx`) meant `node-view.tsx` had
 * to decide *which map to consult* before it could look a type up. Now there is ONE lookup, and the
 * plugin it returns says how to mount itself (`kind`).
 *
 * TWO PLUGIN CONTRACTS, DELIBERATELY. The union is discriminated, not flattened — see
 * ./tiles/types.ts for the reasoning. In short: a tile is data-driven (the host self-fetches
 * `/api/data` and hands it `latest`; it answers `isAvailable` from that), a card is document-driven
 * (it is handed the `CardNode` + inherited `NodeContext` and fetches its own data). A single prop bag
 * would either fetch `/api/data` for every card or hand every plugin props it ignores.
 *
 * THE COMPILE GATE. `satisfies { [T in KnownCardType]: PluginFor<T> }` is total over the vocabulary
 * in lib/dashboard/card-types.ts: adding a type to `V4_TILE_TYPES` or `V4_NON_TILE_CARD_TYPES` is a
 * BUILD ERROR until a plugin is registered here — and registering a card plugin under a tile-view key
 * (or vice versa) is a build error too, because `PluginFor` maps each key to its own contract.
 * Adding a card = one module in ./cards or ./tiles + one line below (+ its `NODE_CATALOG` entry in
 * lib/capabilities/catalog.ts, forced by that catalog's `Record<KnownCardType, …>` type).
 *
 * ABSENT STRUCTURALLY: `tiles`. It is still a v3 descriptor card type — persisted descriptors hold
 * `tiles` cards and `rewriteV3ToV4` reads them — but it is not a v4 card type: it became a `row`
 * group (§8.1). So it never appears here, the lookup misses, and it takes the §8.4 labelled-
 * placeholder branch like any other unknown type. Its plugin (`tiles-card.tsx`) died with the v3
 * renderer that was its only mount (stage 9).
 *
 * Client-only: never import this (or any plugin module) from lib/ or server code — the shared,
 * server-safe card vocabulary lives in lib/dashboard/card-types.ts + lib/capabilities/catalog.ts.
 */
import type { KnownCardType, TileView } from "@/lib/dashboard/card-types";
import type { CardPlugin } from "./cards/types";
import type { TilePlugin } from "./tiles/types";
// Tile plugins (the promoted §8.1 tile views).
import { solarTile } from "./tiles/solar";
import { loadTile } from "./tiles/load";
import { hotWaterTile } from "./tiles/hot-water";
import { batteryTile } from "./tiles/battery";
import { houseToGridTile } from "./tiles/house-to-grid";
import { amberTile } from "./tiles/amber";
import { evTile } from "./tiles/ev";
import { renewablesTile } from "./tiles/renewables";
import { oeGridTile } from "./tiles/oe-grid";
// Card plugins (the non-tile card types).
import { chartPlugin } from "./cards/chart";
import { sankeyPlugin } from "./cards/sankey";
import { amberNowPlugin } from "./cards/amber-now";
import { amberTimelinePlugin } from "./cards/amber-timeline";
import { generatorRunsPlugin } from "./cards/generator-runs";
import { deviceMetricsPlugin } from "./cards/device-metrics";
import { batteryContentsPlugin } from "./cards/battery-contents";
import { evProvenancePlugin } from "./cards/ev-provenance";
import { batteryProvenanceHistoryPlugin } from "./cards/battery-provenance-history";

/** What a `CARD_RENDERERS` lookup yields. Discriminate on `kind` before mounting. */
export type NodePlugin = TilePlugin | CardPlugin;

/** The contract a given card type's plugin must satisfy — tile views render through tile plugins. */
type PluginFor<T extends KnownCardType> = T extends TileView
  ? TilePlugin
  : CardPlugin;

export const CARD_RENDERERS = {
  // --- tile views (§8.1: small cards; the host self-fetches and gates on isAvailable) -----------
  solar: solarTile,
  load: loadTile,
  hotWater: hotWaterTile,
  battery: batteryTile,
  "house-to-grid": houseToGridTile,
  amber: amberTile,
  ev: evTile,
  renewables: renewablesTile,
  "oe-grid": oeGridTile,
  // --- non-tile card types (handed the node + its inherited context) ---------------------------
  chart: chartPlugin,
  sankey: sankeyPlugin,
  "amber-now": amberNowPlugin,
  "amber-timeline": amberTimelinePlugin,
  "generator-runs": generatorRunsPlugin,
  "device-metrics": deviceMetricsPlugin,
  "battery-contents": batteryContentsPlugin,
  "ev-provenance": evProvenancePlugin,
  "battery-provenance-history": batteryProvenanceHistoryPlugin,
} satisfies { [T in KnownCardType]: PluginFor<T> };
