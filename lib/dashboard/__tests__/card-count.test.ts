import { describe, it, expect } from "@jest/globals";
import { countCardNodes, emptyDashboardV4, type DashboardV4 } from "../v4";
import { Area, newUuidV7 } from "@/lib/ids";

/**
 * `countCardNodes` — the "how many cards" figure behind `/dashboard`'s list and `/admin/dashboards`.
 *
 * 🛑 This exists because the count has been WRONG, not because it was untested. It was once read off
 * a column nothing wrote any more, so every dashboard created through the UI reported **0 cards** on
 * `/admin/dashboards` — nothing broken, but indistinguishable from data loss. Count off `doc`.
 *
 * The cases that matter are structural: groups are not cards, and nesting must not hide a card from
 * the count (the seed puts small cards inside a `row` group inside a section group — the exact shape
 * a shallow `root.children.length` would undercount).
 */
const area = Area.encode(newUuidV7());

describe("countCardNodes", () => {
  it("counts nothing in an empty document", () => {
    expect(countCardNodes(emptyDashboardV4())).toBe(0);
  });

  it("does not count GROUPS — only leaf cards", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [
          { kind: "group", area, heading: true, children: [] },
          { kind: "group", area, heading: true, children: [] },
        ],
      },
    };
    expect(countCardNodes(doc)).toBe(0);
  });

  it("counts cards nested at any depth — the real seed shape", () => {
    // section group → [ row group → 3 small cards, sankey card, chart card ]
    const doc: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [
          {
            kind: "group",
            area,
            heading: true,
            children: [
              {
                kind: "group",
                direction: "row",
                children: [
                  { kind: "card", type: "power" },
                  { kind: "card", type: "battery" },
                  { kind: "card", type: "grid" },
                ],
              },
              { kind: "card", type: "sankey" },
              { kind: "card", type: "chart" },
            ],
          },
        ],
      },
    };
    expect(countCardNodes(doc)).toBe(5);
    // The undercount this replaces: the top level holds ONE child, and that child is a group.
    expect(doc.root.children.length).toBe(1);
  });

  it("counts across sibling sections", () => {
    const section = (n: number) => ({
      kind: "group" as const,
      area,
      heading: true,
      children: Array.from({ length: n }, () => ({
        kind: "card" as const,
        type: "power",
      })),
    });
    const doc: DashboardV4 = {
      version: 4,
      root: { kind: "group", children: [section(2), section(3)] },
    };
    expect(countCardNodes(doc)).toBe(5);
  });
});
