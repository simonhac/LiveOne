import { describe, expect, it } from "@jest/globals";
import {
  rankBindingChains,
  servingKey,
  type ChainCandidate,
} from "../binding-chain";

function binding(
  pointUid: string,
  logicalPath: string | null,
  metricType: string,
  priority = 0,
  { ordinal = 0, active = true } = {},
): ChainCandidate {
  return { pointUid, logicalPath, metricType, priority, ordinal, active };
}

const ranks = (candidates: ChainCandidate[]) =>
  rankBindingChains(candidates).map((r) => [r.item.pointUid, r.rank]);

/** What a serving path takes — the same `rank === 0` filter every caller applies. */
const winners = (candidates: ChainCandidate[]) =>
  rankBindingChains(candidates)
    .filter((r) => r.rank === 0)
    .map((r) => r.item.pointUid);

describe("binding chains", () => {
  it("contends on the serving key, not the (role, metric) slot", () => {
    // Kinkora's load slot: four circuits, four distinct paths. Every one of them serves — this is
    // the case a naive "one winner per slot" rule would break, silently deleting three circuits.
    const circuits = [
      binding("hvac", "load.hvac", "power", 0),
      binding("pool", "load.pool", "power", 1),
      binding("hws", "load.hws", "power", 2),
      binding("ev", "load.ev", "power", 3),
    ];
    expect(winners(circuits)).toEqual(["ev", "hvac", "hws", "pool"]);
  });

  it("orders two points on ONE serving key by priority, lowest first", () => {
    // The Kinkora `bidi.battery/soc` case: Mondo (device 6) preferred, the Fronius (device 5) behind
    // it. Input order is the reverse of the answer, so this cannot pass by accident.
    expect(
      ranks([
        binding("fronius", "bidi.battery", "soc", 1),
        binding("mondo", "bidi.battery", "soc", 0),
      ]),
    ).toEqual([
      ["mondo", 0],
      ["fronius", 1],
    ]);
  });

  it("keeps power and soc on the same stem apart — the metric is half the key", () => {
    expect(
      ranks([
        binding("p", "bidi.battery", "power", 0),
        binding("s", "bidi.battery", "soc", 0),
      ]),
    ).toEqual([
      ["p", 0],
      ["s", 0],
    ]);
  });

  it("ranks an inactive point behind an active one it outranks by priority", () => {
    // An inactive point cannot produce a reading, and the series layer skips it outright. Letting
    // authored priority hold the slot anyway would cost the area the path entirely — which is the
    // one thing a fallback chain exists to prevent.
    expect(
      ranks([
        binding("preferred", "bidi.battery", "soc", 0, { active: false }),
        binding("spare", "bidi.battery", "soc", 1),
      ]),
    ).toEqual([
      ["spare", 0],
      ["preferred", 1],
    ]);
  });

  it("still names a winner when every member is inactive", () => {
    expect(
      ranks([
        binding("b", "bidi.battery", "soc", 1, { active: false }),
        binding("a", "bidi.battery", "soc", 0, { active: false }),
      ]),
    ).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("is deterministic when priority ties — ordinal, then uuid", () => {
    // `area_bindings_slot_priority_unique` makes priority unique per (area, role, metric), but a
    // serving key is not a slot, so a tie is reachable across roles. Without these tiebreaks the
    // winner would depend on row arrival order — the original defect, in a new place.
    expect(
      ranks([
        binding("zz", "bidi.grid", "power", 0, { ordinal: 1 }),
        binding("aa", "bidi.grid", "power", 0, { ordinal: 1 }),
        binding("mm", "bidi.grid", "power", 0, { ordinal: 0 }),
      ]),
    ).toEqual([
      ["mm", 0],
      ["aa", 1],
      ["zz", 2],
    ]);
  });

  it("never contends stemless points — they have no field to fight over", () => {
    // `servingKey` is null, so two stemless points of the same metric both serve. Their series ids
    // fall back to the per-point `{index}/{metric}`, which cannot collide.
    expect(
      ranks([
        binding("x", null, "power"),
        binding("y", null, "power"),
        binding("z", "load", "power"),
      ]),
    ).toEqual([
      ["z", 0],
      ["x", 0],
      ["y", 0],
    ]);
  });

  it("leaves a lone binding at rank 0 whatever its priority", () => {
    expect(ranks([binding("only", "load", "power", 7)])).toEqual([["only", 0]]);
  });

  it("builds the serving key the latest hash and the series id both use", () => {
    expect(servingKey("bidi.battery", "soc")).toBe("bidi.battery/soc");
    expect(servingKey(null, "soc")).toBeNull();
  });
});
