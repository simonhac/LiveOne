/**
 * 🛑 TEMPORARY, alongside `lib/capabilities/strategy-v3.ts` — stages 9 and 13 delete both.
 *
 * The strategy is v4-native now; `/device/{id}` and the two legacy dashboard routes still read v3
 * through the projection. This pins the two things the v4 shape does not itself carry (the raw
 * `section.areaId`, and the chart cards' v3 `id`) and asserts the projection loses nothing else, by
 * round-tripping it back through `rewriteV3ToV4`.
 */
import { describe, it, expect } from "@jest/globals";
import { Area, Device } from "@/lib/ids";
import { buildAreaStrategy } from "@/lib/capabilities/strategy";
import { areaStrategyGroupToV3 } from "@/lib/capabilities/strategy-v3";
import { rewriteV3ToV4, pureAreaRef } from "@/lib/dashboard/v3-to-v4";
import { normalizeDocV4 } from "@/lib/dashboard/v4-validate";
import type { CapabilityId } from "@/lib/capabilities/registry";

const caps = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids);
const AREA_UUID = "01980000-0000-7000-8000-000000000001";
const GRID_DEVICE = Device.encode("01980000-0000-7000-8000-00000000000c");

const fullSiteGroup = () =>
  buildAreaStrategy({
    area: Area.encode(AREA_UUID),
    capabilities: caps(
      "solar/power",
      "load/power",
      "battery/soc",
      "grid/power",
      "generator-running",
    ),
    aggregate: true,
    gridDevice: GRID_DEVICE,
    leadWithDeviceMetrics: true,
  });

const project = (group: ReturnType<typeof fullSiteGroup>, areaId: string) =>
  areaStrategyGroupToV3(group, {
    areaId,
    handleForDevice: new Map([[GRID_DEVICE, 12]]),
  });

describe("areaStrategyGroupToV3", () => {
  it("re-attaches the raw section areaId, including /device's non-uuid synthetic key", () => {
    expect(project(fullSiteGroup(), AREA_UUID).sections[0].areaId).toBe(
      AREA_UUID,
    );
    expect(project(fullSiteGroup(), "device-14").sections[0].areaId).toBe(
      "device-14",
    );
  });

  it("restores the v3 chart card ids the v4 doc does not store", () => {
    const cards = project(fullSiteGroup(), AREA_UUID).sections[0].cards;
    expect(cards.filter((c) => c.type === "chart").map((c) => c.id)).toEqual([
      "chart:load",
      "chart:generation",
    ]);

    const lines = buildAreaStrategy({
      area: Area.encode(AREA_UUID),
      capabilities: caps("solar/power", "load/power"),
      aggregate: false,
    });
    const linesCards = project(lines, AREA_UUID).sections[0].cards;
    expect(linesCards.find((c) => c.type === "chart")?.id).toBe("chart:lines");
  });

  it("inverts the row group back to a tiles card, with the device pin as a legacy handle", () => {
    const cards = project(fullSiteGroup(), AREA_UUID).sections[0].cards;
    expect(cards[0]).toEqual({ type: "device-metrics", variant: "table" });
    expect(cards[1]).toEqual({
      type: "tiles",
      tiles: [
        { view: "solar" },
        { view: "load" },
        { view: "battery" },
        { view: "house-to-grid" },
        { view: "renewables" },
        { view: "oe-grid", deviceSystemId: 12 },
      ],
    });
    expect(cards[cards.length - 1]).toEqual({ type: "generator-runs" });
  });

  it("round-trips: rewriting the projection back to v4 reproduces the group", () => {
    const group = fullSiteGroup();
    const back = rewriteV3ToV4(project(group, AREA_UUID), {
      areaRef: pureAreaRef,
      deviceRef: (handle) => {
        if (handle !== 12) throw new Error(`unexpected device pin: ${handle}`);
        return GRID_DEVICE;
      },
    });
    expect(back).toEqual(
      normalizeDocV4({
        version: 4,
        root: { kind: "group", direction: "column", children: [group] },
      }),
    );
  });
});
