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
 * The 10 tile views — the SINGLE source of the tile vocabulary. The node render registry
 * (components/dashboard/registry.tsx) is total over `KnownCardType` and maps every tile view to a
 * TILE plugin, so adding a view here is a compile error until a plugin exists; the capability
 * catalog (`NODE_CATALOG`) is likewise total, and keys its tile-order helper off `TileId`.
 */
export const V4_TILE_TYPES = [
  "solar",
  "load",
  "hotWater",
  "battery",
  "house-to-grid",
  "amber",
  "ev",
  // Engine state + the run-control cog for a hub-supervised generator (DeepSea).
  "generator",
  "renewables",
  "oe-grid",
] as const;

/** A tile view — the render vocabulary of the tile plugins (9 device tiles + `oe-grid`). */
export type TileView = (typeof V4_TILE_TYPES)[number];

/**
 * The capability-catalog subset of `TileView`: the 9 tiles derived from a device's capabilities.
 * `oe-grid` is excluded — it is bound to an OpenElectricity region device, not capability-derived.
 */
export type TileId = Exclude<TileView, "oe-grid">;

/**
 * The 11 known card types that are NOT tile views (v3 `DashboardCardType` minus `tiles` → group,
 * plus the v4-native cards that never had a v3 form — `daily-stripe`, `heatmap`).
 */
export const V4_NON_TILE_CARD_TYPES = [
  "chart",
  "sankey",
  "amber-now",
  "amber-timeline",
  // Was `generator-runs`; role-generic since EV charge tracking (see `runsConfigSchema`). Documents
  // holding the old type still parse — `CardType` is open — and render as a labelled placeholder,
  // so a doc that misses the migration degrades visibly rather than silently.
  "runs",
  "device-metrics",
  "battery-contents",
  "ev-provenance",
  "battery-provenance-history",
  "daily-stripe",
  "heatmap",
] as const;

/**
 * The 21 known card types = the 10 promoted tile views + the 11 non-tile card types.
 * Kept as a const tuple so it doubles as the runtime set and the literal union.
 */
export const V4_CARD_TYPES = [
  ...V4_TILE_TYPES,
  ...V4_NON_TILE_CARD_TYPES,
] as const;

export type KnownCardType = (typeof V4_CARD_TYPES)[number];

/** The 10 promoted tile views — v4 card types that render via a tile plugin, not a card plugin. */
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
 * A known card type that renders through a CARD plugin (components/dashboard/cards/) rather than a
 * tile plugin — i.e. the 11 non-tile types. The v3 `tiles` container is absent from
 * `V4_CARD_TYPES` STRUCTURALLY (it became a `row` group, §8.1), so it is not one of these either.
 */
export type NonTileCardType = (typeof V4_NON_TILE_CARD_TYPES)[number];

export const NON_TILE_CARD_TYPES: ReadonlySet<string> =
  new Set<NonTileCardType>(V4_NON_TILE_CARD_TYPES);

export function isNonTileCardType(t: string): t is NonTileCardType {
  return NON_TILE_CARD_TYPES.has(t);
}

// `v4CardRenderKind(type) -> "tile" | "card" | "unknown"` lived here between config-v4 Phase 14
// stages 6 and 7. It is gone: with ONE registry (components/dashboard/registry.tsx) the renderer no
// longer has to know which map to consult before looking a type up, so it dispatches on the plugin
// it gets back (`kind`), and "unknown" is simply a lookup miss. Keeping a second, parallel statement
// of the same classification here would be exactly the drift stage 7 removed. The vocabulary
// predicates above stay — they are facts about the type lists, not about rendering.

/**
 * `type` is an open string (§8.4): a newer client/agent may persist a card type this build doesn't
 * know. The `string & {}` keeps editor autocomplete for the known set without closing the union.
 */
export type CardType = KnownCardType | (string & {});

// ---------------------------------------------------------------------------
// Per-type config schemas (§8.4 "known types: strict per-type config").
// `chart`, `device-metrics`, `daily-stripe` and `heatmap` carry structural config; the promoted tiles
// may carry an (inert) `features` list, preserved verbatim. Every other known type is BARE.
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

// --- daily-stripe -----------------------------------------------------------------------------

/**
 * The default stripe ramp — the blue→red HSL pair the HWS lab timeline passes
 * (`app/labs/kinkora-hws/page.tsx`).
 *
 * 🛑 INLINE LITERALS ON PURPOSE, and they must stay that way: this module is SERVER-SAFE (the doc
 * validator imports it on the request path), while `lib/heatmap-colors.ts` pulls in the heavy,
 * ESM-only `d3-scale-chromatic`. Do not import a palette from there to "share" it — keep these two
 * in sync by hand instead.
 */
export const DAILY_STRIPE_DEFAULT_PALETTE: readonly [string, string] = [
  "hsl(210,80%,50%)",
  "hsl(0,80%,50%)",
];

/** The aggregation suffix a stripe series is served with; omitted ⇒ the metric's preferred one. */
export const STRIPE_AGGS = ["avg", "last", "delta", "min", "max"] as const;

/** One series a `daily-stripe` paints: a logical path, optionally pinned to a given aggregation. */
const stripeSeriesShape = {
  /** A `role.stem/metric` logical path, e.g. `load.hws/temperature` — NOT a series id. */
  logicalPath: z.string().min(1),
  /** Overrides `PointInfo.getPreferredAggregationForMetricType(metric)`. */
  agg: z.enum(STRIPE_AGGS).optional(),
};

/**
 * The `daily-stripe` card config — RENDER OPTIONS ONLY (§8.3: `area`/`device` live in the node
 * envelope, never here; there is deliberately no `systemId`/`areaId`/`deviceId` key).
 *
 * Reproduces the HWS lab timeline exactly via:
 *   `{ primary: {logicalPath: "load.hws/temperature"},
 *      state:   {logicalPath: "load.hws/power", onThreshold: 100},
 *      days: 7, color: {min: 30, max: 40, from: …, to: …}, unit: "°C", label: "Faucet" }`
 */
export const dailyStripeConfigSchema = z
  .strictObject({
    /** The coloured row. */
    primary: z.strictObject(stripeSeriesShape),
    /** Optional second series painted as a thin on/off strip. Omit ⇒ one gradient row per day. */
    state: z
      .strictObject({
        ...stripeSeriesShape,
        /** `state` values strictly above this count as "on". */
        onThreshold: z.number().default(0),
      })
      .optional(),
    /** Local days to draw. Capped at 7 by `/api/history`'s 7.5-day window for `interval=5m`. */
    days: z.number().int().min(1).max(7).default(7),
    /** Colour domain + ramp. `min`/`max` omitted ⇒ resolved from the data (fallback `[0, 1]`). */
    color: z
      .strictObject({
        min: z.number().optional(),
        max: z.number().optional(),
        from: z.string().min(1),
        to: z.string().min(1),
      })
      .optional(),
    /** Suffix for tooltip/legend values, e.g. `"°C"`. */
    unit: z.string().optional(),
    /** Legend prefix, e.g. `"Faucet"`. */
    label: z.string().optional(),
  })
  .describe("daily-stripe");
export type DailyStripeConfig = z.infer<typeof dailyStripeConfigSchema>;

// --- heatmap ------------------------------------------------------------------------------------

/**
 * The palette vocabulary — the keys of `HEATMAP_PALETTES` (lib/heatmap-colors.ts).
 *
 * 🛑 DUPLICATED ON PURPOSE, for the same reason `DAILY_STRIPE_DEFAULT_PALETTE` above is inlined:
 * this module is SERVER-SAFE (the doc validator imports it on the request path) while
 * `lib/heatmap-colors.ts` pulls in the heavy, ESM-only `d3-scale-chromatic`. Deriving these keys
 * from `keyof typeof HEATMAP_PALETTES` would make a zod *value* out of a `d3` import and drag it
 * into every validator call site (and into jest, which does not transform `node_modules`).
 *
 * It is not a trust-me duplication: the CLIENT-side plugin
 * (components/dashboard/cards/heatmap.tsx) carries a compile-time assertion that this tuple and
 * `HeatmapPaletteKey` are mutually assignable, so adding or renaming a palette without updating
 * this list is a build error there. Keep the two in sync.
 */
export const HEATMAP_PALETTE_KEYS = [
  "viridis",
  "plasma",
  "turbo",
  "rdylbu",
  "greens",
] as const;
export type HeatmapPaletteName = (typeof HEATMAP_PALETTE_KEYS)[number];

/**
 * The `heatmap` card config — RENDER OPTIONS ONLY (§8.3: the device this heatmap is *of* comes from
 * the node envelope's `device`/`area`, never from here; there is deliberately no
 * `systemId`/`deviceId` key).
 *
 * BOTH KEYS ARE OPTIONAL, and that is the card's default behaviour rather than an omission: with
 * neither set the card renders the same selector-driven surface as `/device/{id}/heatmap`, so a
 * bare `{ kind: "card", type: "heatmap", device: … }` node is already useful. Setting a key PINS the
 * control (the matching `<Select>` disappears); set both for a chart-only card.
 */
export const heatmapConfigSchema = z
  .strictObject({
    /** A `role.stem/metric` logical path to pin, e.g. `load.hws/temperature`. Omit ⇒ selector. */
    series: z.string().min(1).optional(),
    /** A `HEATMAP_PALETTES` key to pin. Omit ⇒ palette selector (defaulting to `viridis`). */
    palette: z.enum(HEATMAP_PALETTE_KEYS).optional(),
  })
  .describe("heatmap");
export type HeatmapCardConfig = z.infer<typeof heatmapConfigSchema>;

// --- runs ---------------------------------------------------------------------------------------

/**
 * The `runs` card config — WHICH TRACKED DEVICE'S run periods to list.
 *
 * This card was `generator-runs` until EV charge tracking landed, and the rename is the point: the
 * run-tracking stack underneath it (`detect.ts`, `derived_intervals`, the `?role=` API) has always
 * been role-generic, and the card type was the only thing asserting otherwise. Same reasoning as
 * migration 0055's `*_power_w` → `*_signal`: a name that only accidentally described its contents.
 *
 * `role` is a closed enum rather than the open `RoleId`, because a card can only exist for a role
 * that is `device.trackable` in lib/roles/registry.ts. Keep the two in step by hand — the alternative
 * (deriving the enum from `TRACKABLE_ROLE_IDS`) would make a zod *value* out of the role registry and
 * drag it into every validator call site, the same trade `HEATMAP_PALETTE_KEYS` above documents.
 *
 * 🛑 The role does NOT choose the device: `area`/`device` live in the node envelope (§8.3). Because
 * a detector hangs off a member area-of-one rather than the composite (see `ensureRunDetector`), a
 * `runs` card on a multi-device area must carry `device: dv_…` or it resolves no detector and renders
 * empty.
 */
export const runsConfigSchema = z
  .strictObject({
    role: z.enum(["generator", "ev"]).default("generator"),
  })
  .describe("runs");
export type RunsCardConfig = z.infer<typeof runsConfigSchema>;

/**
 * Known-type → config schema. A known type ABSENT from this map is BARE: it must carry no config
 * (an empty object or omitted). Unknown (non-`KnownCardType`) types bypass this entirely — their
 * config is opaque and preserved (§8.4).
 */
export const CARD_CONFIG_SCHEMAS: Partial<Record<KnownCardType, z.ZodType>> = {
  chart: chartConfigSchema,
  "device-metrics": deviceMetricsConfigSchema,
  "daily-stripe": dailyStripeConfigSchema,
  heatmap: heatmapConfigSchema,
  runs: runsConfigSchema,
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
