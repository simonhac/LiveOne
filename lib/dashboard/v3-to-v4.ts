/**
 * config-v4 v3→v4 dashboard rewriter (clean-sheet §11 dark-prep, §8.1 model).
 *
 * Pure structural transform of a v3 descriptor into a v4 doc, behind an injectable `LegacyRefResolver`:
 *   - `areaRef(ref)` is PURE (dual-accept raw-uuid-or-`ar_` → `ar_`, `lib/areas/ref.ts`) and ships DARK.
 *   - `deviceRef(legacySystemId)` needs the minted `devices` + `legacy_handles` (cutover), so it is
 *     injected — real at/after cutover, a stub in dark rehearsal/tests.
 *
 * Mapping (§8.1): each v3 section → an area-bound `heading` group; the v3 `tiles` card → a `row` group
 * of small cards; every other card + every tile → a leaf `card` (`tiles` disappears as a type). Scope
 * refs move to the envelope (`area` on the section group, `device` on device-bound cards/tiles) — the
 * §8.3 invariant. The result is normalized (ids assigned). Names/headers/layout stay DERIVED (§8.2).
 *
 * SCOPE EQUIVALENCE: the set of AREAS referenced by the v4 doc (via `collectRefs`) equals
 * `descriptorAreaIds(v3)` — the rewrite never widens a dashboard's area scope. Device pins are carried
 * verbatim as `device` refs; the Phase-6 scope resolver enforces each device is readable (§8.4 "refs
 * always strict"), so an orphan/stale pin cannot widen scope end-to-end.
 */
import type { AreaId, DeviceId } from "@/lib/ids";
import { areaRefToArId } from "@/lib/areas/ref";
import type { DashboardV3, AreaSectionV3, CardV3, TileV3 } from "./v3";
import type { DashboardV4, DashboardNode, GroupNode, CardNode } from "./v4";
import { normalizeDocV4 } from "./v4-validate";

export interface LegacyRefResolver {
  /** Area ref (raw uuid OR already `ar_`) → `ar_` TypeID. Pure; ships dark. */
  areaRef(areaRef: string): AreaId;
  /** Legacy integer `system_id` → `dv_` TypeID. Needs minted devices + legacy_handles (cutover). */
  deviceRef(legacySystemId: number): DeviceId;
}

/**
 * The pure half of a resolver, usable today: an area ref (raw uuid OR already `ar_`, dual-accept —
 * PR2 flips `section.areaId` to `ar_` ahead of the one-off descriptor migration) → `ar_` TypeID.
 * Throws if `areaRef` is neither (a programmer error — every real descriptor's `areaId` is one).
 */
export const pureAreaRef = (areaRef: string): AreaId => {
  const encoded = areaRefToArId(areaRef);
  if (!encoded) throw new TypeError(`not a valid area ref: ${areaRef}`);
  return encoded;
};

/** Rewrite a v3 descriptor into a normalized v4 doc. */
export function rewriteV3ToV4(
  v3: DashboardV3,
  resolver: LegacyRefResolver,
): DashboardV4 {
  const doc: DashboardV4 = {
    version: 4,
    root: {
      kind: "group",
      direction: "column",
      children: v3.sections.map((s) => rewriteSection(s, resolver)),
    },
  };
  return normalizeDocV4(doc);
}

function rewriteSection(
  section: AreaSectionV3,
  r: LegacyRefResolver,
): GroupNode {
  const group: GroupNode = {
    kind: "group",
    area: r.areaRef(section.areaId),
    heading: true, // an area-bound section renders its header by default (§8.1)
    children: section.cards.map((c) => rewriteCard(c, r)),
  };
  if (section.hidden) group.hidden = true;
  return group;
}

function rewriteCard(card: CardV3, r: LegacyRefResolver): DashboardNode {
  // The v3 "tiles" card is not a v4 card type — it becomes a wrapping row group of small cards.
  if (card.type === "tiles") {
    const group: GroupNode = {
      kind: "group",
      direction: "row",
      wrap: true,
      children: (card.tiles ?? []).map((t) => rewriteTile(t, r)),
    };
    if (card.hidden) group.hidden = true;
    return group;
  }

  const node: CardNode = { kind: "card", type: card.type };
  if (card.hidden) node.hidden = true;
  if (typeof card.deviceSystemId === "number") {
    node.device = r.deviceRef(card.deviceSystemId);
  }
  if (card.type === "chart") {
    // CardV3.chart is optional, but the v4 chart config requires a `variant`. Default a config-less
    // v3 chart (type-legal, degenerate) to the base `lines` variant so the rewrite stays valid.
    node.config = card.chart ?? { variant: "lines" };
  } else if (card.type === "device-metrics" && card.variant) {
    node.config = { variant: card.variant };
  }
  return node;
}

function rewriteTile(tile: TileV3, r: LegacyRefResolver): CardNode {
  const node: CardNode = { kind: "card", type: tile.view };
  if (tile.hidden) node.hidden = true;
  if (typeof tile.deviceSystemId === "number") {
    node.device = r.deviceRef(tile.deviceSystemId);
  }
  if (tile.features && tile.features.length > 0) {
    node.config = { features: tile.features };
  }
  return node;
}
