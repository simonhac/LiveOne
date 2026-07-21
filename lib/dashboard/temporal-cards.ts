/**
 * Server-safe (React-free) helpers for deciding whether a dashboard hosts a component that can
 * "travel" through time — i.e. reads the shared temporal window (`?period/?start/?end`) — and which
 * area's timezone the single page-header navigator should format its label in.
 *
 * The predicate mirrors the render/collapse logic in `components/Dashboard.tsx` + the card plugins,
 * keyed on the SAME `chartCapable` flag the renderer gates the site charts on, so navigator
 * visibility always matches what actually renders (incl. on `/device`, where `chartCapable` is
 * undefined so the site charts — and the navigator — stay hidden while the lines chart still shows).
 */
import type { DashboardV3, CardV3 } from "@/lib/dashboard/v3";
import type { ReadableArea } from "@/lib/areas/list";

/** Does this card read the shared temporal window (render or consume it)? */
function cardTravels(card: CardV3, chartCapable: boolean): boolean {
  switch (card.type) {
    case "chart":
      // The lines variant mounts immediately (rendered its own navigator today); the stacked-areas
      // variant folds into SiteChartsGroup, which only renders when the area is chartCapable.
      return card.chart?.variant === "stacked-areas" ? chartCapable : true;
    case "sankey":
      return chartCapable; // SiteChartsGroup, gated on chartCapable
    case "generator-runs":
      return true; // consumes the shared window
    case "tiles":
      return (card.tiles ?? []).some((t) => !t.hidden && t.view === "hotWater");
    default:
      return false;
  }
}

/** True when at least one visible card in a visible section reads the shared temporal window. */
export function hasTimeTravelingCard(
  descriptor: DashboardV3,
  areaById: Map<string, ReadableArea>,
): boolean {
  return descriptor.sections
    .filter((s) => !s.hidden)
    .some((section) => {
      const capable = !!areaById.get(section.areaId)?.chartCapable;
      return section.cards
        .filter((c) => !c.hidden)
        .some((c) => cardTravels(c, capable));
    });
}

/**
 * The handle whose timezone the header navigator formats its label in — the first non-hidden
 * section's Area handle. Undefined while the areas are still resolving (navigator holds until then).
 */
export function primaryHandle(
  descriptor: DashboardV3,
  areaById: Map<string, ReadableArea>,
): number | undefined {
  const s = descriptor.sections.find((x) => !x.hidden);
  return s ? areaById.get(s.areaId)?.legacySystemId : undefined;
}
