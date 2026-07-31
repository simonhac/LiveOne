/**
 * The pure half of `AddAreaDialog` (config-v4 Phase 14 stage 14). These live here rather than beside
 * the component because `components/` is not a jest root — a test placed there is silently not
 * collected.
 */
import { describe, it, expect } from "@jest/globals";
import {
  appendGroupToDoc,
  docAreaRefs,
  docHasCards,
  describeDocWriteError,
} from "../add-area";
import { emptyDashboardV4, type DashboardV4, type GroupNode } from "../v4";
import { validateDocV4 } from "../v4-validate";
import { Area } from "@/lib/ids";

const AREA_A = Area.generate();
const AREA_B = Area.generate();

/** A seed group shaped like `buildSeedGroupPreview`'s output: area-bound, heading, one card. */
function seedGroup(area: string): GroupNode {
  return {
    kind: "group",
    area: area as GroupNode["area"],
    heading: true,
    direction: "column",
    children: [{ kind: "card", type: "sankey" }],
  };
}

function docWith(...groups: GroupNode[]): DashboardV4 {
  return {
    version: 4,
    root: { kind: "group", direction: "column", children: [...groups] },
  };
}

describe("appendGroupToDoc", () => {
  it("appends to root.children and preserves order", () => {
    const next = appendGroupToDoc(
      docWith(seedGroup(AREA_A)),
      seedGroup(AREA_B),
    );
    expect(next.root.children).toHaveLength(2);
    expect((next.root.children[0] as GroupNode).area).toBe(AREA_A);
    expect((next.root.children[1] as GroupNode).area).toBe(AREA_B);
  });

  it("does not mutate the input doc (a failed PUT must leave the rendered tree alone)", () => {
    const before = docWith(seedGroup(AREA_A));
    const snapshot = JSON.stringify(before);
    appendGroupToDoc(before, seedGroup(AREA_B));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("works on an empty document (the brand-new-dashboard path)", () => {
    const next = appendGroupToDoc(emptyDashboardV4(), seedGroup(AREA_A));
    expect(next.root.children).toHaveLength(1);
  });

  it("produces a document the v4 PUT validator accepts", () => {
    const next = appendGroupToDoc(emptyDashboardV4(), seedGroup(AREA_A));
    const result = validateDocV4(next);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("docAreaRefs", () => {
  it("returns the ar_ refs the document already carries (the picker's exclusion set)", () => {
    expect(
      docAreaRefs(docWith(seedGroup(AREA_A), seedGroup(AREA_B))).sort(),
    ).toEqual([AREA_A, AREA_B].sort());
  });

  it("is empty for an empty document", () => {
    expect(docAreaRefs(emptyDashboardV4())).toEqual([]);
  });

  it("sees an area bound BELOW the top level — the v3 section walk did not", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [
          {
            kind: "group",
            children: [{ kind: "card", type: "sankey", area: AREA_A as never }],
          },
        ],
      },
    };
    expect(docAreaRefs(doc)).toEqual([AREA_A]);
  });

  it("de-duplicates a repeated ref", () => {
    const doc = docWith(seedGroup(AREA_A), seedGroup(AREA_A));
    expect(docAreaRefs(doc)).toEqual([AREA_A]);
  });
});

describe("docHasCards", () => {
  it("is false for an empty document", () => {
    expect(docHasCards(emptyDashboardV4())).toBe(false);
  });

  it("is false for a document of empty groups — still nothing to render", () => {
    const doc = docWith({ kind: "group", children: [] });
    expect(docHasCards(doc)).toBe(false);
  });

  it("is true once a seed group is spliced in", () => {
    expect(
      docHasCards(appendGroupToDoc(emptyDashboardV4(), seedGroup(AREA_A))),
    ).toBe(true);
  });

  it("finds a card nested several groups deep", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [
          {
            kind: "group",
            children: [
              { kind: "group", children: [{ kind: "card", type: "sankey" }] },
            ],
          },
        ],
      },
    };
    expect(docHasCards(doc)).toBe(true);
  });
});

describe("describeDocWriteError", () => {
  it("surfaces a 422 validation issue — the body is {errors}, NOT {error}", () => {
    const msg = describeDocWriteError(422, {
      errors: [{ path: "root.children[1].config.variant", message: "invalid" }],
      warnings: [],
    });
    expect(msg).toContain("invalid");
    expect(msg).toContain("root.children[1].config.variant");
    expect(msg).not.toBe("Could not add the area");
  });

  it("uses {error} for a 403 unreadable-ref refusal", () => {
    expect(describeDocWriteError(403, { error: "area not readable" })).toBe(
      "area not readable",
    );
  });

  it("falls back for an empty/unparseable body", () => {
    expect(describeDocWriteError(500, null)).toBe("Could not add the area");
    expect(describeDocWriteError(422, { errors: [] })).toBe(
      "Could not add the area",
    );
  });
});
