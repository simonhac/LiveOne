/**
 * The area "strategy" — the default dashboard for an area, generated from its CAPABILITIES (the HA
 * Lovelace-strategy idea). Capability-driven replacement for the vendor-keyed `buildDefaultDashboardV3`
 * in lib/dashboard/v3.ts: no `vendorType`, no `getLayout`, no `availableViews`/`hasGenerator` opts —
 * the card set falls out of the capability set + one structural `aggregate` flag.
 *
 * config-v4 Phase 14: this emits a **v4 `GroupNode` natively** (clean-sheet §8.1) — an area-bound
 * `heading` group whose children are leaf `card` nodes plus, when the area has tiles, one
 * `direction:"row"` group of small cards. There is no v3 detour: the seed path
 * (`lib/dashboard/v4-seed.ts`) wraps this group straight into a document. The §8.3 invariant holds by
 * construction — the only scope refs emitted are `group.area` and the `oe-grid` card's `device`, both
 * envelope fields; `config` never carries a ref.
 *
 * Layout is DERIVED, never stored:
 *  - amber      ⇐ `isPricingOnly(caps)` (a grid rate/price with no actual power/energy roles).
 *  - stacked    ⇐ `aggregate` (a multi-source/aggregate area → two stacked-area site charts).
 *  - lines      ⇐ otherwise (a single-inverter sidebar → one lines chart).
 *
 * A never-seen vendor that advertises solar+load power auto-gets tiles + chart with ZERO code — its
 * vendor string never appears here.
 *
 * The remaining v3 consumers (`/device/{id}`, the two legacy dashboard routes) read this through the
 * temporary projection in `strategy-v3.ts`, which stages 9 and 13 delete.
 */
import type { AreaId, DeviceId } from "@/lib/ids";
import type { CapabilitySet } from "@/lib/capabilities/derive";
import type { CapabilityId } from "@/lib/capabilities/registry";
import { availableTilesFromCaps } from "@/lib/capabilities/catalog";
import type { CardNode, DashboardNode, GroupNode } from "@/lib/dashboard/v4";

export interface AreaStrategyContext {
  /**
   * The area this group binds — the §8.3 envelope ref every child inherits. Omitted only by the
   * v3 projection's area-less `/device/{id}` case (a bare device with no Area), which re-attaches its
   * synthetic `device-{id}` render key on the way back to v3.
   */
  area?: AreaId;
  /** The area's capability set (server: from point_info+config; viewer: from latest). */
  capabilities: CapabilitySet;
  /** Multi-source/aggregate area → stacked-area site charts; else a single lines chart. */
  aggregate: boolean;
  /** OE region member device for the `oe-grid` card (from grid context); omit if the area has none. */
  gridDevice?: DeviceId;
  /** Lead with the generic all-values `device-metrics` table (only the live /device viewer sets this). */
  leadWithDeviceMetrics?: boolean;
}

/** Capabilities that count as a real power/energy role (i.e. NOT a pricing-only Amber feed). */
const POWER_ROLE_CAPS: readonly CapabilityId[] = [
  "solar/power",
  "load/power",
  "battery/power",
  "battery/soc",
  "grid/power",
  "ev/soc",
  "load.hws/temperature",
];

/** A pricing-only feed (Amber): has a grid rate but no actual power/energy role → the amber layout. */
export function isPricingOnly(caps: CapabilitySet): boolean {
  return caps.has("grid/rate") && !POWER_ROLE_CAPS.some((c) => caps.has(c));
}

/** The area-bound section group (§8.1: an `area` + `heading:true` group IS a v3 "section"). */
function sectionGroup(
  ctx: AreaStrategyContext,
  children: DashboardNode[],
): GroupNode {
  return {
    kind: "group",
    ...(ctx.area ? { area: ctx.area } : {}),
    heading: true,
    children,
  };
}

const card = (type: string, extra?: Partial<CardNode>): CardNode => ({
  kind: "card",
  type,
  ...extra,
});

/**
 * Build an area's default group. Pure: node ids are NOT assigned here — `normalizeDocV4` mints the
 * `n_…` ids once the group is wrapped into a document (v4-seed.ts).
 */
export function buildAreaStrategy(ctx: AreaStrategyContext): GroupNode {
  const caps = ctx.capabilities;
  const lead: CardNode[] = ctx.leadWithDeviceMetrics
    ? [card("device-metrics", { config: { variant: "table" } })]
    : [];

  // Amber: pricing dashboard — the two amber cards, no tiles/charts.
  if (isPricingOnly(caps)) {
    return sectionGroup(ctx, [
      ...lead,
      card("amber-now"),
      card("amber-timeline"),
    ]);
  }

  const supported = availableTilesFromCaps(caps);

  // Instrumentation-only device (generator / sensor pack): no tile represents its points and it has no
  // OE grid member → just the generic device-metrics card (+ generator-runs if tracked).
  if (supported.length === 0 && ctx.gridDevice == null) {
    const children: DashboardNode[] = ctx.leadWithDeviceMetrics
      ? [...lead]
      : [card("device-metrics")];
    if (caps.has("generator-running")) children.push(card("generator-runs"));
    if (caps.has("battery/provenance"))
      children.push(card("battery-provenance-history"));
    return sectionGroup(ctx, children);
  }

  // NOTE: `battery-provenance-history` is deliberately NOT seeded below on the main tiles/pricing
  // paths, even though a populated battery area legitimately carries `battery/provenance` too (the
  // blend point is bound into the parent Area, not just the helper). v1 scope: catalog-only there —
  // mirrors `battery-contents`/`ev-provenance`, which an area opts into via the card gallery rather
  // than getting by default. Revisit if/when this card graduates to the default composition.

  // The v3 `tiles` container is a structural `row` group in v4 — every tile is just a small card.
  const tiles: CardNode[] = supported.map((view) => card(view));
  if (ctx.gridDevice != null) {
    tiles.push(card("oe-grid", { device: ctx.gridDevice }));
  }
  const children: DashboardNode[] = [
    ...lead,
    { kind: "group", direction: "row", wrap: true, children: tiles },
  ];

  if (ctx.aggregate) {
    children.push(
      card("chart", { config: { variant: "stacked-areas", split: "load" } }),
      card("chart", {
        config: { variant: "stacked-areas", split: "generation" },
      }),
    );
  } else {
    children.push(card("chart", { config: { variant: "lines" } }));
  }

  if (caps.has("generator-running")) children.push(card("generator-runs"));

  return sectionGroup(ctx, children);
}
