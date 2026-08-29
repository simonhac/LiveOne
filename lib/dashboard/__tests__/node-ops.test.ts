/**
 * The pure structural ops behind `scripts/ops/dashboard/cli.ts`. Every transform must be pure (the
 * input doc untouched), must round-trip `validateDocV4`, and must fail with the typed
 * `NodeOpError` codes the CLI presents.
 */
import { describe, it, expect } from "@jest/globals";
import {
  countMissingIds,
  findNode,
  insertNode,
  moveNode,
  NodeOpError,
  removeNode,
  setNodeProps,
  stripNodeIds,
  subtreeIds,
} from "../node-ops";
import { validateDocV4 } from "../v4-validate";
import {
  countCardNodes,
  countCardsInNode,
  type CardNode,
  type DashboardV4,
  type GroupNode,
} from "../v4";
import { Area, Device } from "@/lib/ids";

const AREA = Area.generate();
const DEVICE = Device.generate();

/**
 * A normalized fixture (every node carries an id):
 *   n_0 group
 *   ├─ n_1 group row heading area
 *   │  ├─ n_2 card solar
 *   │  └─ n_3 card battery
 *   └─ n_4 card chart
 */
function fixture(): DashboardV4 {
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
          direction: "row",
          heading: true,
          area: AREA,
          children: [
            { id: "n_2", kind: "card", type: "solar" },
            { id: "n_3", kind: "card", type: "battery" },
          ],
        },
        {
          id: "n_4",
          kind: "card",
          type: "chart",
          config: { variant: "lines" },
        },
      ],
    },
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected NodeOpError, got none");
  } catch (err) {
    expect(err).toBeInstanceOf(NodeOpError);
    expect((err as NodeOpError).code).toBe(code);
  }
}

describe("findNode", () => {
  it("locates the root with no parent", () => {
    const found = findNode(fixture(), "n_0")!;
    expect(found.parent).toBeNull();
    expect(found.index).toBe(-1);
    expect(found.path).toBe("root");
    expect(found.depth).toBe(1);
  });

  it("locates a nested node with parent, index, path and depth", () => {
    const found = findNode(fixture(), "n_3")!;
    expect(found.node.kind).toBe("card");
    expect(found.parent?.id).toBe("n_1");
    expect(found.index).toBe(1);
    expect(found.path).toBe("root.children[0].children[1]");
    expect(found.depth).toBe(3);
  });

  it("returns null for an unknown id", () => {
    expect(findNode(fixture(), "n_zz")).toBeNull();
  });
});

describe("insertNode", () => {
  const card: CardNode = { kind: "card", type: "load" };

  it("appends to the root by default and strips inserted ids", () => {
    const doc = fixture();
    const foreign: GroupNode = {
      id: "n_1", // would collide — must be stripped
      kind: "group",
      children: [{ id: "n_2", kind: "card", type: "ev" }],
    };
    const res = insertNode(doc, foreign, { parentId: "n_0" });
    expect(res.parentId).toBe("n_0");
    expect(res.index).toBe(2);
    expect(res.path).toBe("root.children[2]");
    const inserted = res.doc.root.children[2] as GroupNode;
    expect(inserted.id).toBeUndefined();
    expect(inserted.children[0].id).toBeUndefined();
    // The result validates (no duplicate-node-id) and normalizes cleanly.
    const validated = validateDocV4(res.doc);
    expect(validated.valid).toBe(true);
  });

  it("inserts at an explicit index / before / after", () => {
    const doc = fixture();
    const atIndex = insertNode(doc, card, { parentId: "n_1", index: 1 });
    expect(
      ((atIndex.doc.root.children[0] as GroupNode).children[1] as CardNode)
        .type,
    ).toBe("load");

    const before = insertNode(doc, card, { beforeId: "n_3" });
    expect(before.parentId).toBe("n_1");
    expect(before.index).toBe(1);

    const after = insertNode(doc, card, { afterId: "n_3" });
    expect(after.index).toBe(2);
  });

  it("does not mutate the input doc", () => {
    const doc = fixture();
    const snapshot = JSON.parse(JSON.stringify(doc));
    insertNode(doc, card, { beforeId: "n_2" });
    expect(doc).toEqual(snapshot);
  });

  it("rejects a missing parent, a card parent, a bad index, and a root sibling", () => {
    expectCode(
      () => insertNode(fixture(), card, { parentId: "n_zz" }),
      "node-not-found",
    );
    expectCode(
      () => insertNode(fixture(), card, { parentId: "n_4" }),
      "not-a-group",
    );
    expectCode(
      () => insertNode(fixture(), card, { parentId: "n_1", index: 3 }),
      "index-out-of-range",
    );
    expectCode(
      () => insertNode(fixture(), card, { beforeId: "n_0" }),
      "root-immutable",
    );
  });
});

describe("removeNode", () => {
  it("removes a whole subtree and returns it", () => {
    const res = removeNode(fixture(), "n_1");
    expect(res.path).toBe("root.children[0]");
    expect(res.removed.id).toBe("n_1");
    expect(res.doc.root.children.map((c) => c.id)).toEqual(["n_4"]);
    expect(validateDocV4(res.doc).valid).toBe(true);
  });

  it("refuses the root and an unknown id", () => {
    expectCode(() => removeNode(fixture(), "n_0"), "root-immutable");
    expectCode(() => removeNode(fixture(), "n_zz"), "node-not-found");
  });
});

describe("moveNode", () => {
  it("moves a node beside a sibling elsewhere, ids preserved", () => {
    const res = moveNode(fixture(), "n_4", { beforeId: "n_2" });
    const group = res.doc.root.children[0] as GroupNode;
    expect(group.children.map((c) => c.id)).toEqual(["n_4", "n_2", "n_3"]);
    expect(res.doc.root.children.map((c) => c.id)).toEqual(["n_1"]);
    expect(res.path).toBe("root.children[0].children[0]");
    expect(validateDocV4(res.doc).valid).toBe(true);
  });

  it("reorders within the same parent", () => {
    const res = moveNode(fixture(), "n_2", { afterId: "n_3" });
    const group = res.doc.root.children[0] as GroupNode;
    expect(group.children.map((c) => c.id)).toEqual(["n_3", "n_2"]);
  });

  it("moves into a named parent (append)", () => {
    const res = moveNode(fixture(), "n_4", { parentId: "n_1" });
    const group = res.doc.root.children[0] as GroupNode;
    expect(group.children.map((c) => c.id)).toEqual(["n_2", "n_3", "n_4"]);
  });

  it("refuses the root, a self-target, its own subtree, and a missing anchor", () => {
    expectCode(
      () => moveNode(fixture(), "n_0", { parentId: "n_1" }),
      "root-immutable",
    );
    expectCode(() => moveNode(fixture(), "n_1", { afterId: "n_1" }), "cycle");
    expectCode(() => moveNode(fixture(), "n_1", { parentId: "n_1" }), "cycle");
    expectCode(() => moveNode(fixture(), "n_1", { beforeId: "n_2" }), "cycle");
    expectCode(
      () => moveNode(fixture(), "n_1", { parentId: "n_zz" }),
      "node-not-found",
    );
  });

  it("does not mutate the input doc", () => {
    const doc = fixture();
    const snapshot = JSON.parse(JSON.stringify(doc));
    moveNode(doc, "n_4", { beforeId: "n_2" });
    expect(doc).toEqual(snapshot);
  });
});

describe("setNodeProps", () => {
  it("sets and deletes envelope props", () => {
    const set = setNodeProps(fixture(), "n_2", {
      hidden: true,
      columns: 3,
      device: DEVICE,
    });
    const card = (set.doc.root.children[0] as GroupNode)
      .children[0] as CardNode;
    expect(card.hidden).toBe(true);
    expect(card.size).toEqual({ columns: 3 });
    expect(card.device).toBe(DEVICE);
    expect(validateDocV4(set.doc).valid).toBe(true);

    const cleared = setNodeProps(set.doc, "n_2", {
      hidden: null,
      columns: null,
      device: null,
    });
    const after = (cleared.doc.root.children[0] as GroupNode)
      .children[0] as CardNode;
    expect("hidden" in after).toBe(false);
    expect("size" in after).toBe(false);
    expect("device" in after).toBe(false);
  });

  it("sets group props and card type/config, and clears area", () => {
    const g = setNodeProps(fixture(), "n_1", {
      direction: "column",
      heading: null,
      area: null,
    });
    const group = g.doc.root.children[0] as GroupNode;
    expect(group.direction).toBe("column");
    expect("heading" in group).toBe(false);
    expect("area" in group).toBe(false);

    const c = setNodeProps(fixture(), "n_4", {
      type: "device-metrics",
      config: { variant: "table" },
    });
    const card = c.doc.root.children[1] as CardNode;
    expect(card.type).toBe("device-metrics");
    expect(card.config).toEqual({ variant: "table" });
    expect(validateDocV4(c.doc).valid).toBe(true);

    const noConfig = setNodeProps(fixture(), "n_4", { config: null });
    expect("config" in (noConfig.doc.root.children[1] as CardNode)).toBe(false);
  });

  it("rejects kind-mismatched keys and unknown nodes", () => {
    expectCode(
      () => setNodeProps(fixture(), "n_2", { direction: "row" }),
      "wrong-kind",
    );
    expectCode(
      () => setNodeProps(fixture(), "n_1", { type: "chart" }),
      "wrong-kind",
    );
    expectCode(
      () => setNodeProps(fixture(), "n_1", { config: {} }),
      "wrong-kind",
    );
    expectCode(
      () => setNodeProps(fixture(), "n_zz", { hidden: true }),
      "node-not-found",
    );
  });

  it("does not mutate the input doc", () => {
    const doc = fixture();
    const snapshot = JSON.parse(JSON.stringify(doc));
    setNodeProps(doc, "n_3", { hidden: true, columns: 2 });
    expect(doc).toEqual(snapshot);
  });
});

describe("helpers", () => {
  it("stripNodeIds drops every id in a subtree", () => {
    const stripped = stripNodeIds(fixture().root) as GroupNode;
    expect(subtreeIds(stripped)).toEqual([]);
  });

  it("subtreeIds lists the node and all descendants", () => {
    expect(subtreeIds(fixture().root)).toEqual([
      "n_0",
      "n_1",
      "n_2",
      "n_3",
      "n_4",
    ]);
  });

  it("countCardsInNode counts leaf cards of a subtree", () => {
    const doc = fixture();
    expect(countCardsInNode(doc.root)).toBe(3);
    expect(countCardsInNode(doc.root.children[0])).toBe(2); // the n_1 group
    expect(countCardsInNode(doc.root.children[1])).toBe(1); // the lone n_4 card
    expect(countCardsInNode(doc.root)).toBe(countCardNodes(doc));
  });

  it("countMissingIds counts nodes normalizeDocV4 would assign", () => {
    expect(countMissingIds(fixture())).toBe(0);
    const doc = fixture();
    delete (doc.root.children[1] as CardNode).id;
    delete (doc.root.children[0] as GroupNode).children[0].id;
    expect(countMissingIds(doc)).toBe(2);
  });
});
