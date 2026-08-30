/**
 * The pure half of `AddAreaDialog`. These live here rather than beside
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
import {
  emptyDashboardV4,
  walkNodes,
  type DashboardV4,
  type GroupNode,
} from "../v4";
import { normalizeDocV4, validateDocV4 } from "../v4-validate";
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

/**
 * What `GET /api/v4/areas/{ar_}/default-group` actually returns: the group after
 * `buildSeedDoc` normalized it INSIDE a throwaway one-group document — so it already carries `n_…`
 * ids that mean nothing in the destination doc. Reproduces the shape exactly, not an idealised one.
 */
function normalizedSeedGroup(area: string): GroupNode {
  const doc = normalizeDocV4({
    version: 4,
    root: { kind: "group", direction: "column", children: [seedGroup(area)] },
  });
  return doc.root.children[0] as GroupNode;
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

  // 🛑 REGRESSION, originally measured against a live dev server: `default-group` normalizes its
  // group inside a throwaway one-group document, so it arrives carrying ids minted for a document
  // it was never part of. Appending such a group verbatim risks `PUT /api/v4/dashboards/{id}` 422ing
  // `duplicate-node-id` — certain under the old sequential minter (both groups came out `n_1…n_9`),
  // rare but not impossible under random ids. Either way an id belongs to the document that minted
  // it, so the incoming subtree is re-minted; see `stripNodeIds`.
  it("strips the incoming group's server-minted ids, so a SECOND add does not collide", () => {
    const first = appendGroupToDoc(
      emptyDashboardV4(),
      normalizedSeedGroup(AREA_A),
    );
    const persisted = validateDocV4(first).normalized!;
    const second = appendGroupToDoc(persisted, normalizedSeedGroup(AREA_B));

    const result = validateDocV4(second);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);

    // Every node id in the persisted-then-appended doc is unique…
    const ids: string[] = [];
    walkNodes(validateDocV4(second).normalized!, (n) => ids.push(n.id!));
    expect(new Set(ids).size).toBe(ids.length);
    // …and the first area's nodes kept their ids (stable React keys across the save).
    expect((persisted.root.children[0] as GroupNode).id).toBe(
      (second.root.children[0] as GroupNode).id,
    );
  });

  it("is what makes the second add valid — an un-stripped splice really does 422", () => {
    // Negative control for the test above: splice a subtree carrying ids the destination ALREADY
    // holds, which is what an un-stripped graft from a foreign document amounts to.
    //
    // The collision is constructed EXPLICITLY rather than by minting two seed groups and hoping
    // they clash. Node ids are random, so two independently-normalized groups almost never collide
    // — but "almost never" is not "never", and `stripNodeIds` is what makes it impossible. (Under
    // the old sequential minter both groups came out `n_1, n_2, …` and the clash was certain,
    // which is why this test used to be written that way.)
    const doc = validateDocV4(
      appendGroupToDoc(emptyDashboardV4(), normalizedSeedGroup(AREA_A)),
    ).normalized!;
    const alreadyPresent = doc.root.children[0] as GroupNode;
    const naive: DashboardV4 = {
      ...doc,
      root: {
        ...doc.root,
        children: [
          ...doc.root.children,
          { ...alreadyPresent, area: AREA_B as GroupNode["area"] },
        ],
      },
    };
    const result = validateDocV4(naive);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("duplicate-node-id");
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

  it("sees an area bound BELOW the top level, not just at the root's children", () => {
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
