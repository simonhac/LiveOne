/**
 * The area "strategy" — the default dashboard for an area, generated from its CAPABILITIES (the HA
 * Lovelace-strategy idea). Capability-driven replacement for the vendor-keyed `buildDefaultDashboardV3`
 * in lib/dashboard/v3.ts: no `vendorType`, no `getLayout`, no `availableViews`/`hasGenerator` opts —
 * the card set falls out of the capability set + one structural `aggregate` flag.
 *
 * Layout is DERIVED, never stored:
 *  - amber      ⇐ `isPricingOnly(caps)` (a grid rate/price with no actual power/energy roles).
 *  - stacked    ⇐ `aggregate` (a multi-source/aggregate area → two stacked-area site charts).
 *  - lines      ⇐ otherwise (a single-inverter sidebar → one lines chart).
 *
 * A never-seen vendor that advertises solar+load power auto-gets tiles + chart with ZERO code — its
 * vendor string never appears here.
 *
 * Parity: for the /device-viewer context (capabilities from `latest`), this reproduces
 * `buildDefaultDashboardV3` byte-for-byte (see __tests__/strategy-equivalence.test.ts). For the SEED /
 * AddArea callers — which used to pass no `availableViews` and therefore got ALL tiles — the strategy
 * now emits only the CAPABILITY-SUPPORTED tiles (descriptor == rendered set, the "no reflow" goal);
 * that is an intended improvement, not a regression, and never touches an already-stored descriptor.
 */
import type { CardV3, DashboardV3, TileV3 } from "@/lib/dashboard/v3";
import type { CapabilitySet } from "@/lib/capabilities/derive";
import type { CapabilityId } from "@/lib/capabilities/registry";
import { availableTilesFromCaps } from "@/lib/capabilities/catalog";

export interface AreaStrategyContext {
  areaId: string;
  /** The area's capability set (server: from point_info+config; viewer: from latest). */
  capabilities: CapabilitySet;
  /** Multi-source/aggregate area → stacked-area site charts; else a single lines chart. */
  aggregate: boolean;
  /** OE region member device for the `oe-grid` tile (from grid context); omit if the area has none. */
  gridDeviceSystemId?: number;
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

export function buildAreaStrategy(ctx: AreaStrategyContext): DashboardV3 {
  const { areaId, capabilities: caps } = ctx;
  const lead: CardV3[] = ctx.leadWithDeviceMetrics
    ? [{ type: "device-metrics", variant: "table" }]
    : [];

  // Amber: pricing dashboard — the two amber cards, no tiles/charts.
  if (isPricingOnly(caps)) {
    return {
      version: 3,
      sections: [
        {
          areaId,
          cards: [...lead, { type: "amber-now" }, { type: "amber-timeline" }],
        },
      ],
    };
  }

  const supported = availableTilesFromCaps(caps);

  // Instrumentation-only device (generator / sensor pack): no tile represents its points and it has no
  // OE grid member → just the generic device-metrics card (+ generator-runs if tracked).
  if (supported.length === 0 && ctx.gridDeviceSystemId == null) {
    const cards: CardV3[] = ctx.leadWithDeviceMetrics
      ? [...lead]
      : [{ type: "device-metrics" }];
    if (caps.has("generator-running")) cards.push({ type: "generator-runs" });
    if (caps.has("battery/provenance"))
      cards.push({ type: "battery-provenance-history" });
    return { version: 3, sections: [{ areaId, cards }] };
  }

  // NOTE: `battery-provenance-history` is deliberately NOT seeded below on the main tiles/pricing
  // paths, even though a populated battery area legitimately carries `battery/provenance` too (the
  // blend point is bound into the parent Area, not just the helper). v1 scope: catalog-only there —
  // mirrors `battery-contents`/`ev-provenance`, which an area opts into via the card gallery rather
  // than getting by default. Revisit if/when this card graduates to the default composition.

  const tiles: TileV3[] = supported.map((view) => ({ view }));
  if (ctx.gridDeviceSystemId != null) {
    tiles.push({ view: "oe-grid", deviceSystemId: ctx.gridDeviceSystemId });
  }
  const cards: CardV3[] = [...lead, { type: "tiles", tiles }];

  if (ctx.aggregate) {
    cards.push(
      {
        type: "chart",
        id: "chart:load",
        chart: { variant: "stacked-areas", split: "load" },
      },
      {
        type: "chart",
        id: "chart:generation",
        chart: { variant: "stacked-areas", split: "generation" },
      },
    );
  } else {
    cards.push({
      type: "chart",
      id: "chart:lines",
      chart: { variant: "lines" },
    });
  }

  if (caps.has("generator-running")) cards.push({ type: "generator-runs" });

  return { version: 3, sections: [{ areaId, cards }] };
}
