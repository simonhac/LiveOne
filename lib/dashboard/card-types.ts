/**
 * config-v4 dashboard card types — the unified card vocabulary + per-type config schemas.
 *
 * v4 merges the v3 card registry and tile registry into ONE `card` primitive (clean-sheet §8.1):
 * every tile view is a first-class card type, and the v3 `tiles` container becomes a
 * structural `group` (so it is NOT a card type here). This module also OWNS the tile vocabulary
 * (`TileView`/`TileId`), which the tile plugins and the capability catalog read directly — the v3
 * descriptor types (v3.ts, cards.ts) no longer define it. `type` is an OPEN string at the document level
 * (§8.4 — unknown types persist with opaque config and render as a placeholder); `KnownCardType` is the
 * closed set this build knows how to render + validate.
 *
 * DARK: nothing renders v4 yet; this is the Phase-5 pure core behind the unchanged v3 app.
 */
import { z } from "zod";

/**
 * The 9 tile views — the SINGLE source of the tile vocabulary. The tile plugin registry
 * (components/dashboard/tiles/registry.tsx) is `satisfies Record<TileView, TilePlugin>`, so adding a
 * view here is a compile error until a plugin exists; the capability catalog keys off `TileId`.
 */
export const V4_TILE_TYPES = [
  "solar",
  "load",
  "hotWater",
  "battery",
  "house-to-grid",
  "amber",
  "ev",
  "renewables",
  "oe-grid",
] as const;

/** A tile view — the render vocabulary of the tile plugins (8 device tiles + `oe-grid`). */
export type TileView = (typeof V4_TILE_TYPES)[number];

/**
 * The capability-catalog subset of `TileView`: the 8 tiles derived from a device's capabilities.
 * `oe-grid` is excluded — it is bound to an OpenElectricity region device, not capability-derived.
 */
export type TileId = Exclude<TileView, "oe-grid">;

/** The 9 known card types that are NOT tile views (v3 `DashboardCardType` minus `tiles` → group). */
export const V4_NON_TILE_CARD_TYPES = [
  "chart",
  "sankey",
  "amber-now",
  "amber-timeline",
  "generator-runs",
  "device-metrics",
  "battery-contents",
  "ev-provenance",
  "battery-provenance-history",
] as const;

/**
 * The 18 known card types = the 9 promoted tile views + the 9 non-tile card types.
 * Kept as a const tuple so it doubles as the runtime set and the literal union.
 */
export const V4_CARD_TYPES = [
  ...V4_TILE_TYPES,
  ...V4_NON_TILE_CARD_TYPES,
] as const;

export type KnownCardType = (typeof V4_CARD_TYPES)[number];

/** The 9 promoted tile views — v4 card types that render via a tile plugin, not a card plugin. */
export const TILE_VIEW_TYPES: ReadonlySet<string> = new Set<TileView>(
  V4_TILE_TYPES,
);

export function isTileViewType(type: string): type is TileView {
  return TILE_VIEW_TYPES.has(type);
}

export const KNOWN_CARD_TYPES: ReadonlySet<string> = new Set(V4_CARD_TYPES);

export function isKnownCardType(t: string): t is KnownCardType {
  return KNOWN_CARD_TYPES.has(t);
}

/**
 * `type` is an open string (§8.4): a newer client/agent may persist a card type this build doesn't
 * know. The `string & {}` keeps editor autocomplete for the known set without closing the union.
 */
export type CardType = KnownCardType | (string & {});

// ---------------------------------------------------------------------------
// Per-type config schemas (§8.4 "known types: strict per-type config").
// Only `chart` and `device-metrics` carry structural config today; the promoted tiles may carry an
// (inert) `features` list, preserved verbatim. Every other known type is BARE (no config).
// ---------------------------------------------------------------------------

/** The `chart` card config — mirrors v3 `ChartCardConfig` (lib/dashboard/v3.ts). */
export const chartConfigSchema = z
  .strictObject({
    variant: z.enum(["lines", "stacked-areas"]),
    split: z.enum(["load", "generation"]).optional(),
    series: z.array(z.string()).optional(),
  })
  .describe("chart");
export type ChartConfig = z.infer<typeof chartConfigSchema>;

/** The `device-metrics` card config — mirrors v3 `CardV3.variant`. */
export const deviceMetricsConfigSchema = z
  .strictObject({
    variant: z.enum(["grid", "table"]).optional(),
  })
  .describe("device-metrics");
export type DeviceMetricsConfig = z.infer<typeof deviceMetricsConfigSchema>;

/** The `TileFeature` forward-seam union (inert today), preserved on promoted tile cards. */
export const tileFeatureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sparkline"), series: z.string() }),
  z.strictObject({ kind: z.literal("breakdown") }),
  z.strictObject({ kind: z.literal("flow-direction") }),
  z.strictObject({ kind: z.literal("toggle"), command: z.string() }),
]);
export type TileFeature = z.infer<typeof tileFeatureSchema>;

/** Config a promoted tile card may carry — just the inert features list. */
export const tileCardConfigSchema = z.strictObject({
  features: z.array(tileFeatureSchema).optional(),
});
export type TileCardConfig = z.infer<typeof tileCardConfigSchema>;

/**
 * Known-type → config schema. A known type ABSENT from this map is BARE: it must carry no config
 * (an empty object or omitted). Unknown (non-`KnownCardType`) types bypass this entirely — their
 * config is opaque and preserved (§8.4).
 */
export const CARD_CONFIG_SCHEMAS: Partial<Record<KnownCardType, z.ZodType>> = {
  chart: chartConfigSchema,
  "device-metrics": deviceMetricsConfigSchema,
  // Promoted tiles: inert `features` only.
  solar: tileCardConfigSchema,
  load: tileCardConfigSchema,
  hotWater: tileCardConfigSchema,
  battery: tileCardConfigSchema,
  "house-to-grid": tileCardConfigSchema,
  amber: tileCardConfigSchema,
  ev: tileCardConfigSchema,
  renewables: tileCardConfigSchema,
  "oe-grid": tileCardConfigSchema,
};
