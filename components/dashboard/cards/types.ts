/**
 * The CARD half of the node plugin contract — one plugin per non-tile `KnownCardType`, registered
 * alongside the tile plugins in the single `CARD_RENDERERS` (components/dashboard/registry.tsx).
 * See ../tiles/types.ts for why the two contracts stayed distinct when the registries merged.
 *
 * A card plugin bundles the render component (ex-`AreaXxx` wrapper from the deleted v3 renderer) with the
 * host-facing render policy: how it behaves while the section's Area handle is unresolved
 * (`pending`) and whether it collapses into the section's single SiteChartsGroup (`collapseKey`).
 * The declarative catalog data (label, capability requirements, scope) stays server-safe in
 * `lib/capabilities/catalog.ts` — this layer is client-only render binding.
 *
 * v4-NATIVE (config-v4 Phase 14 stage 6): a plugin is handed the `CardNode` and its inherited §8.1
 * `NodeContext` directly. The v4→v3 adapter (`lib/dashboard/v4-adapt.ts`'s `synthCardV3` /
 * `synthSectionV3`), which used to fabricate a `CardV3`/`AreaSectionV3` per render, is GONE — the
 * per-type config that used to be spread onto named `CardV3` fields (`chart`, `variant`) is read
 * from `node.config` (schemas in lib/dashboard/card-types.ts), and the section's area ref is read
 * from `context.area` (an `ar_` TypeID, where the adapter downgraded it to a raw uuid).
 */
import type React from "react";
import type { CardNode } from "@/lib/dashboard/v4";
import type { NodeContext } from "@/lib/dashboard/resolve-shell";
import type { NonTileCardType } from "@/lib/dashboard/card-types";

export interface CardRenderProps {
  /** The v4 card node. Plugins read its per-type `config` (§8.4) — never its scope refs, which
   *  arrive resolved below. */
  node: CardNode;
  /** The node's INHERITED §8.1 scope binding — its own `area`/`device` if set, else the nearest
   *  ancestor's. battery-provenance-history reads `context.area` (undefined on a device page,
   *  which binds no area). */
  context: NodeContext;
  /** The addressing handle: the bound Area's handle (`areas.legacy_system_id`), else the bound
   *  device's `system_id`. Defined for `pending: "host-skeleton"` plugins (the host gates on it);
   *  may be undefined for `pending: "self"` plugins. */
  handle?: number;
  /** `context.device` resolved to its legacy `system_id`. Device-bound cards (`device-metrics`,
   *  `generator-runs`) read `deviceSystemId ?? handle`: their data is keyed by a member device,
   *  not the synthetic area handle. Undefined ⇒ no device in scope. */
  deviceSystemId?: number;
  /**
   * True ⇒ a <SiteChartsGroup> for THIS SAME `handle` is mounted in this card's group and is
   * driving `siteDataQuery`. A card whose data is a subset of that payload can then read it instead
   * of issuing its own request (React Query dedupes on the shared key). Only `chart`'s `lines`
   * variant uses it today — see LinesChartCard. False/undefined ⇒ nothing is fetching site data
   * here, so the card MUST fall back to its own query.
   */
  sharedSiteData?: boolean;
}

export interface CardPlugin {
  /** The registry's discriminant: `node-view.tsx` dispatches on this after ONE lookup. */
  kind: "card";
  type: NonTileCardType;
  /**
   * The card's reserved footprint in CSS px, BEFORE any of its data has arrived — what the host
   * draws in place of the card while its own queries settle.
   *
   * REQUIRED, deliberately: the registry's `satisfies { [T in KnownCardType]: PluginFor<T> }` gate
   * then makes "a new card type that doesn't say how much room it needs" a build error, which is
   * the only durable way to stop the loading-relayout regressing one card at a time.
   *
   * 🛑 These numbers are MEASURED, not guessed — read off the settled card at a wide viewport (see
   * docs/performance/dashboard-layout-stability.md for the measurement recipe and the recorded
   * values). A footprint that is too SMALL shifts the page down when content lands; one that is too
   * LARGE leaves the card sitting in dead space, because the slot's min-height never shrinks. Where
   * the height is a function of config rather than of data — daily-stripe's `days`, device-metrics'
   * `variant` — compute it from `node.config` instead of averaging the cases.
   *
   * It is an estimate, not a promise: a card whose real height depends on how many rows its data
   * has (device-metrics, amber-timeline) cannot be exact here, and will still resize a little when
   * its data lands. Those are the KNOWN residuals, listed in the doc above.
   */
  footprint: (node: CardNode) => number;
  /**
   * Unresolved-handle behavior:
   *  - "host-skeleton" (default): the host reserves `footprint` until the handle resolves,
   *    then mounts Render with a defined handle. (All chart-ish cards.)
   *  - "self": Render always mounts and handles handle === undefined itself.
   */
  pending?: "host-skeleton" | "self";
  /**
   * Site-charts collapse membership. Non-null ⇒ this card does NOT render standalone; it
   * contributes the returned key ("sankey" | "chart:load" | "chart:generation") to the section's
   * single SiteChartsGroup (see ./site-charts.tsx). sankey: () => "sankey"; chart: stacked-areas
   * variant only, null for lines. Called on the NODE alone — it runs in the host's collapse pass,
   * before any context/handle resolution, so it may read `node.config` and nothing else.
   */
  collapseKey?: (node: CardNode) => string | null;
  Render: React.FC<CardRenderProps>;
}
