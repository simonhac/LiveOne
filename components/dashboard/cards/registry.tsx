"use client";

/**
 * The card render registry — one plugin per non-tile `KnownCardType`. The `satisfies` check makes
 * this exhaustive at compile time: adding a type to `V4_NON_TILE_CARD_TYPES`
 * (lib/dashboard/card-types.ts) is a type error until a plugin is registered here. Adding a card =
 * one module in this directory + one line below (+ its catalog entry in lib/capabilities/catalog.ts,
 * forced by `CARD_CATALOG`'s `Record<CardId, …>` type).
 *
 * `tiles` is absent STRUCTURALLY. It is still a v3 descriptor card type — persisted descriptors hold
 * `tiles` cards and `rewriteV3ToV4` reads them — but it is not a v4 card type: it became a `row`
 * group (§8.1), so it is not a `NonTileCardType` and `v4CardRenderKind("tiles")` never reaches this
 * registry. Its plugin (`tiles-card.tsx`) died with the v3 renderer that was its only mount
 * (config-v4 Phase 14 stage 9).
 *
 * Client-only: never import this (or any plugin module) from lib/ or server code — the shared,
 * server-safe card vocabulary lives in lib/dashboard/cards.ts + lib/capabilities/catalog.ts.
 */
import type { NonTileCardType } from "@/lib/dashboard/card-types";
import type { CardPlugin } from "./types";
import { chartPlugin } from "./chart";
import { sankeyPlugin } from "./sankey";
import { amberNowPlugin } from "./amber-now";
import { amberTimelinePlugin } from "./amber-timeline";
import { generatorRunsPlugin } from "./generator-runs";
import { deviceMetricsPlugin } from "./device-metrics";
import { batteryContentsPlugin } from "./battery-contents";
import { evProvenancePlugin } from "./ev-provenance";
import { batteryProvenanceHistoryPlugin } from "./battery-provenance-history";

export const CARD_RENDERERS = {
  chart: chartPlugin,
  sankey: sankeyPlugin,
  "amber-now": amberNowPlugin,
  "amber-timeline": amberTimelinePlugin,
  "generator-runs": generatorRunsPlugin,
  "device-metrics": deviceMetricsPlugin,
  "battery-contents": batteryContentsPlugin,
  "ev-provenance": evProvenancePlugin,
  "battery-provenance-history": batteryProvenanceHistoryPlugin,
} satisfies Record<NonTileCardType, CardPlugin>;
