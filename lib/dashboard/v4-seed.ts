/**
 * config-v4 seed builders — turn an area's capability-derived v3 default section into a v4 node/doc.
 *
 * Both start from `buildAreaStrategyForHandle` (the capability seed) and `rewriteV3ToV4`, differing ONLY
 * in their `deviceRef` posture, because devices have no uuid until the cutover (a stub `dv_` is a fresh
 * UUIDv7 that can never match the cutover-minted device):
 *
 *  - `buildSeedGroupPreview` — a LENIENT mint-per-int `deviceRef` → a COMPLETE preview (incl. the only
 *    device-pinned seed node, the `oe-grid` tile). NEVER persisted (it backs `GET /areas/{id}/default-group`,
 *    the add-card gallery), so the throwaway `dv_` cannot orphan anything at cutover.
 *  - `buildPersistableSeedDoc` — DEVICE-PIN-FREE: `stripDevicePinnedNodes` drops every device-pinned node,
 *    then the rewrite runs with a THROWING `deviceRef` (a hard guard). The persisted doc carries only
 *    cutover-stable `ar_` area refs (§8.3 / area uuids are preserved across the cutover), so it is safe
 *    under BOTH cutover readings (preserve-doc or regenerate-from-descriptor). Backs `POST /dashboards
 *    {seedArea}`. Consequence: a seeded dashboard omits the Local Grid (`oe-grid`) card until §15 makes
 *    `oe-grid` area-level — at which point the strip becomes a no-op and it returns for free.
 */
import { Device, newUuidV7, type DeviceId } from "@/lib/ids";
import { buildAreaStrategyForHandle } from "@/lib/capabilities/server";
import { rewriteV3ToV4, pureAreaRef, type LegacyRefResolver } from "./v3-to-v4";
import type { DashboardV3 } from "./v3";
import type { DashboardV4, GroupNode } from "./v4";

/** A resolver whose `deviceRef` mints a fresh `dv_` per legacy int (memoized). Preview-ONLY — never persisted. */
function lenientResolver(): LegacyRefResolver {
  const devMap = new Map<number, DeviceId>();
  return {
    areaRef: pureAreaRef,
    deviceRef: (n) => {
      let d = devMap.get(n);
      if (!d) {
        d = Device.encode(newUuidV7());
        devMap.set(n, d);
      }
      return d;
    },
  };
}

/** A resolver that REFUSES device refs — proves a rewritten doc is device-pin-free (cutover-safe §8.3). */
const deviceFreeResolver: LegacyRefResolver = {
  areaRef: pureAreaRef,
  deviceRef: (n) => {
    throw new Error(
      `config-v4 seed: unexpected device pin (system ${n}) — a persistable seed must be device-pin-free ` +
        `pre-cutover (call stripDevicePinnedNodes first).`,
    );
  },
};

/**
 * Remove every device-pinned node from a v3 seed. Today the ONLY device-pinned seed node is the `oe-grid`
 * tile (`strategy.ts`); this also drops any device-pinned card (`device-metrics`/`generator-runs` when
 * pinned) and any `tiles` card left empty by the strip, defensively covering future seed shapes.
 */
export function stripDevicePinnedNodes(v3: DashboardV3): DashboardV3 {
  return {
    ...v3,
    sections: v3.sections.map((s) => ({
      ...s,
      cards: s.cards
        // Drop whole device-pinned cards.
        .filter((c) => c.deviceSystemId == null)
        // Drop device-pinned tiles inside a `tiles` card.
        .map((c) =>
          c.type === "tiles" && c.tiles
            ? { ...c, tiles: c.tiles.filter((t) => t.deviceSystemId == null) }
            : c,
        )
        // Drop a `tiles` card the strip emptied.
        .filter((c) => !(c.type === "tiles" && (c.tiles?.length ?? 0) === 0)),
    })),
  };
}

/**
 * Preview the capability-derived v4 seed GROUP for an area (backs `GET /areas/{id}/default-group`). The
 * capability seed is always exactly one section, so the meaningful payload is the single area-bound
 * (`heading:true`) section group at `root.children[0]`. Lenient `deviceRef` → complete, incl. `oe-grid`.
 */
export async function buildSeedGroupPreview(
  areaUuid: string,
  handle: number,
): Promise<GroupNode> {
  const v3 = await buildAreaStrategyForHandle(areaUuid, handle);
  const doc = rewriteV3ToV4(v3, lenientResolver());
  return doc.root.children[0] as GroupNode;
}

/**
 * Build a PERSISTABLE, device-pin-free v4 seed doc for an area (backs `POST /dashboards {seedArea}`).
 * Strips device pins then rewrites with a throwing `deviceRef`, so `collectRefs(doc).devices` is empty.
 */
export async function buildPersistableSeedDoc(
  areaUuid: string,
  handle: number,
): Promise<DashboardV4> {
  const v3 = stripDevicePinnedNodes(
    await buildAreaStrategyForHandle(areaUuid, handle),
  );
  return rewriteV3ToV4(v3, deviceFreeResolver);
}
