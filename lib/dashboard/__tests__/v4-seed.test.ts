import { describe, it, expect } from "@jest/globals";
import { Device, newUuidV7, type DeviceId } from "@/lib/ids";
import { stripDevicePinnedNodes } from "../v4-seed";
import {
  rewriteV3ToV4,
  pureAreaRef,
  type LegacyRefResolver,
} from "../v3-to-v4";
import { collectRefs, validateDocV4 } from "../v4-validate";
import type { DashboardV3 } from "../v3";

/** A seed-shaped v3 section: a `tiles` card (with a device-pinned `oe-grid`), a chart, an unpinned
 *  generator-runs, a device-pinned device-metrics, and a tiles card whose only tile is device-pinned. */
function seedLikeV3(): DashboardV3 {
  const areaId = newUuidV7();
  return {
    version: 3,
    sections: [
      {
        areaId,
        cards: [
          {
            type: "tiles",
            tiles: [
              { view: "solar" },
              { view: "load" },
              { view: "oe-grid", deviceSystemId: 14 },
            ],
          },
          { type: "chart", chart: { variant: "lines" } },
          { type: "generator-runs" }, // unpinned in a real seed
          { type: "device-metrics", deviceSystemId: 1 }, // pinned → dropped
          { type: "tiles", tiles: [{ view: "oe-grid", deviceSystemId: 9 }] }, // only tile pinned → card dropped
        ],
      },
    ],
  };
}

/** Every deviceSystemId still present anywhere in a v3 descriptor. */
function devicePins(v3: DashboardV3): number[] {
  const pins: number[] = [];
  for (const s of v3.sections) {
    for (const c of s.cards) {
      if (c.deviceSystemId != null) pins.push(c.deviceSystemId);
      for (const t of c.tiles ?? []) {
        if (t.deviceSystemId != null) pins.push(t.deviceSystemId);
      }
    }
  }
  return pins;
}

describe("stripDevicePinnedNodes", () => {
  it("removes every device-pinned tile and card, and drops an emptied tiles card", () => {
    const stripped = stripDevicePinnedNodes(seedLikeV3());
    const cards = stripped.sections[0].cards;

    // the pinned device-metrics card and the oe-grid-only tiles card are gone
    expect(cards.map((c) => c.type)).toEqual([
      "tiles",
      "chart",
      "generator-runs",
    ]);
    // the surviving tiles card kept only its unpinned tiles
    expect(cards[0].tiles?.map((t) => t.view)).toEqual(["solar", "load"]);
    // nothing device-pinned remains anywhere
    expect(devicePins(stripped)).toEqual([]);
  });

  it("is a no-op for a device-pin-free descriptor", () => {
    const clean: DashboardV3 = {
      version: 3,
      sections: [
        {
          areaId: newUuidV7(),
          cards: [
            { type: "tiles", tiles: [{ view: "solar" }] },
            { type: "sankey" },
          ],
        },
      ],
    };
    expect(stripDevicePinnedNodes(clean)).toEqual(clean);
  });
});

describe("device-pin-free rewrite (buildPersistableSeedDoc contract)", () => {
  const throwingResolver: LegacyRefResolver = {
    areaRef: pureAreaRef,
    deviceRef: (n) => {
      throw new Error(`unexpected device pin: ${n}`);
    },
  };

  it("rewrites a stripped seed with a throwing deviceRef → valid doc, zero device refs", () => {
    const v3 = seedLikeV3();
    const stripped = stripDevicePinnedNodes(v3);
    const doc = rewriteV3ToV4(stripped, throwingResolver); // must not throw
    expect(validateDocV4(doc).valid).toBe(true);
    expect(collectRefs(doc).devices).toEqual([]);
    // area scope preserved (§8.3): the one section's area survives
    expect(collectRefs(doc).areas.length).toBe(1);
  });

  it("would throw if the seed were NOT stripped (guard is real)", () => {
    expect(() => rewriteV3ToV4(seedLikeV3(), throwingResolver)).toThrow();
  });
});

describe("lenient preview rewrite (buildSeedGroupPreview contract)", () => {
  it("keeps device-pinned oe-grid via a mint-per-int deviceRef", () => {
    const devMap = new Map<number, DeviceId>();
    const lenient: LegacyRefResolver = {
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
    const doc = rewriteV3ToV4(seedLikeV3(), lenient);
    expect(validateDocV4(doc).valid).toBe(true);
    // both device pins (14, 1, 9) are carried; dedup by int → 3 distinct
    expect(collectRefs(doc).devices.length).toBe(3);
  });
});
