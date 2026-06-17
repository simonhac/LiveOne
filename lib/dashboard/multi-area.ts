/**
 * Multi-area composition helpers (Phase 2b) — the pure logic shared by the renderer
 * (components/MultiAreaCards) and the Customize dialog's "add a card from another area" picker.
 *
 * A card composes ANOTHER Area when it carries an `areaId` whose addressing handle (legacy_system_id)
 * differs from the page's own systemId. Only a subset of card types compose cleanly from one Area's
 * data in v1 (see MULTI_AREA_CARD_TYPES); the rest stay page-scoped.
 */
import type { DashboardCardType } from "./cards";
import type { DashboardDescriptor, ModuleCardInstance } from "./descriptor";

/** Card types that can be composed from another Area in v1. */
export const MULTI_AREA_CARD_TYPES: readonly DashboardCardType[] = [
  "tiles",
  "chart",
  "amber-timeline",
  "generator-runs",
];

const MULTI_AREA_SET = new Set<DashboardCardType>(MULTI_AREA_CARD_TYPES);

export function isMultiAreaCardType(t: DashboardCardType): boolean {
  return MULTI_AREA_SET.has(t);
}

/**
 * The descriptor's cards to render in the multi-area section: visible, of a multi-area-capable type,
 * with an `areaId` that resolves (via `legacySystemIdOf`) to a system OTHER than the page's. A card
 * whose Area can't be resolved (unknown/unreadable uuid) or that resolves back to the page system is
 * left to the page's own template, never rendered twice.
 */
export function offAreaCards(
  descriptor: DashboardDescriptor | null,
  legacySystemIdOf: (areaId: string) => number | undefined,
  pageSystemId: number,
): ModuleCardInstance[] {
  if (!descriptor || !Array.isArray(descriptor.cards)) return [];
  return descriptor.cards.filter((c) => {
    if (c.hidden || !c.areaId || !MULTI_AREA_SET.has(c.type)) return false;
    const sid = legacySystemIdOf(c.areaId);
    return sid != null && sid !== pageSystemId;
  });
}
