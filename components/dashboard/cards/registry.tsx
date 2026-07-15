"use client";

/**
 * The card render registry — one plugin per `DashboardCardType`. The `satisfies` check makes this
 * exhaustive at compile time: adding a type to `DashboardCardType` (lib/dashboard/cards.ts) is a
 * type error until a plugin is registered here. Adding a card = one module in this directory + one
 * line below (+ its catalog entry in lib/capabilities/catalog.ts, forced by `CARD_CATALOG`'s
 * `Record<CardId, …>` type).
 *
 * Client-only: never import this (or any plugin module) from lib/ or server code — the shared,
 * server-safe card vocabulary lives in lib/dashboard/cards.ts + lib/capabilities/catalog.ts.
 */
import type { DashboardCardType } from "@/lib/dashboard/v3";
import type { CardPlugin } from "./types";
import { tilesPlugin } from "./tiles-card";
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
  tiles: tilesPlugin,
  chart: chartPlugin,
  sankey: sankeyPlugin,
  "amber-now": amberNowPlugin,
  "amber-timeline": amberTimelinePlugin,
  "generator-runs": generatorRunsPlugin,
  "device-metrics": deviceMetricsPlugin,
  "battery-contents": batteryContentsPlugin,
  "ev-provenance": evProvenancePlugin,
  "battery-provenance-history": batteryProvenanceHistoryPlugin,
} satisfies Record<DashboardCardType, CardPlugin>;
