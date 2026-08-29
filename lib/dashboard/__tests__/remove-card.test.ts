import { describe, it, expect } from "@jest/globals";
import { removeCardsByType } from "@/lib/dashboard/remove-card";
import type { DashboardV4 } from "@/lib/dashboard/v4";

/** A doc shaped like Daylesford's: a tile row inside an area group, then full-width cards. */
function doc(): DashboardV4 {
  return {
    version: 4,
    root: {
      id: "n_0",
      kind: "group",
      direction: "column",
      children: [
        {
          id: "n_1",
          kind: "group",
          area: "ar_01kx8km3a3fh5v2csryvhskzep",
          heading: true,
          children: [
            {
              id: "n_2",
              kind: "group",
              wrap: true,
              direction: "row",
              children: [
                { id: "n_3", kind: "card", type: "solar" },
                { id: "n_4", kind: "card", type: "load" },
                { id: "n_5", kind: "card", type: "battery" },
                { id: "n_6", kind: "card", type: "house-to-grid" },
              ],
            },
            { id: "n_7", kind: "card", type: "chart" },
            { id: "n_8", kind: "card", type: "sankey" },
          ],
        },
      ],
    },
  } as DashboardV4;
}

describe("removeCardsByType", () => {
  it("removes the matching card and reports where it was", () => {
    const { doc: out, removed } = removeCardsByType(doc(), ["house-to-grid"]);
    expect(removed).toEqual(["root.children[0].children[0].children[3] (n_6)"]);
    const row = out.root.children[0] as never as {
      children: { children: { type: string }[] }[];
    };
    expect(row.children[0].children.map((c) => c.type)).toEqual([
      "solar",
      "load",
      "battery",
    ]);
  });

  it("leaves every other card exactly where it was", () => {
    const { doc: out } = removeCardsByType(doc(), ["house-to-grid"]);
    const area = out.root.children[0] as never as {
      children: { kind: string; type?: string }[];
    };
    expect(area.children.slice(1).map((c) => c.type)).toEqual([
      "chart",
      "sankey",
    ]);
  });

  it("does not mutate the input", () => {
    const input = doc();
    const before = JSON.stringify(input);
    removeCardsByType(input, ["house-to-grid"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("is idempotent — a second pass removes nothing", () => {
    const once = removeCardsByType(doc(), ["house-to-grid"]);
    const twice = removeCardsByType(once.doc, ["house-to-grid"]);
    expect(twice.removed).toEqual([]);
    expect(twice.doc).toBe(once.doc);
  });

  it("returns the SAME doc object when nothing matched", () => {
    const input = doc();
    const out = removeCardsByType(input, ["not-a-card-type"]);
    expect(out.doc).toBe(input);
    expect(out.removed).toEqual([]);
  });

  it("keeps a group that empties out — layout intent is not the card's to discard", () => {
    const { doc: out } = removeCardsByType(doc(), [
      "solar",
      "load",
      "battery",
      "house-to-grid",
    ]);
    const area = out.root.children[0] as never as {
      children: { id: string; kind: string; children?: unknown[] }[];
    };
    expect(area.children[0].id).toBe("n_2");
    expect(area.children[0].children).toEqual([]);
  });

  it("removes every occurrence when a type appears more than once", () => {
    const { removed } = removeCardsByType(doc(), ["solar", "sankey"]);
    expect(removed).toHaveLength(2);
  });
});
