/**
 * The pure half of `scripts/utils/migrate-card-type.ts`. These live here rather than beside the
 * script because `scripts/` is not a jest root — a test placed there is silently not collected.
 *
 * The case that motivated the module is the last assertion: a document holding the pre-#338
 * `generator-runs` type, rewritten to `runs`, must come out valid with the `unknown-card-type`
 * warning GONE — that warning is precisely what the prod dashboard was rendering as a grey box.
 */
import { describe, it, expect } from "@jest/globals";
import { rewriteCardType } from "../migrate-card-type";
import { normalizeDocV4, validateDocV4 } from "../v4-validate";
import type { DashboardV4, GroupNode } from "../v4";
import { Device } from "@/lib/ids";

const DEVICE = Device.generate();

/** Shaped like a real seeded doc: a section group holding a `row` of tiles plus a full-width card. */
function docWithNestedCard(type: string): DashboardV4 {
  return {
    version: 4,
    root: {
      kind: "group",
      direction: "column",
      children: [
        {
          kind: "group",
          direction: "column",
          heading: true,
          children: [
            {
              kind: "group",
              direction: "row",
              children: [
                { kind: "card", type: "solar" },
                { kind: "card", type: "battery" },
              ],
            },
            {
              kind: "card",
              type,
              device: DEVICE,
              size: { columns: 12 },
            },
          ],
        },
      ],
    },
  };
}

describe("rewriteCardType", () => {
  it("rewrites a nested card and reports its path", () => {
    const before = docWithNestedCard("generator-runs");
    const { doc, changed } = rewriteCardType(before, "generator-runs", "runs");

    expect(changed).toEqual(["root.children[0].children[1]"]);
    const card = (
      (doc.root.children[0] as GroupNode).children[1] as { type: string }
    ).type;
    expect(card).toBe("runs");
  });

  it("does not mutate the input document", () => {
    const before = docWithNestedCard("generator-runs");
    const snapshot = JSON.parse(JSON.stringify(before));
    rewriteCardType(before, "generator-runs", "runs");
    expect(before).toEqual(snapshot);
  });

  it("preserves id, envelope refs, size and config verbatim", () => {
    const before: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [
          {
            kind: "card",
            id: "n_9",
            type: "generator-runs",
            device: DEVICE,
            size: { columns: 6 },
            config: { legacyKnob: true },
          },
        ],
      },
    };
    const { doc } = rewriteCardType(before, "generator-runs", "runs");
    expect(doc.root.children[0]).toEqual({
      kind: "card",
      id: "n_9",
      type: "runs",
      device: DEVICE,
      size: { columns: 6 },
      config: { legacyKnob: true },
    });
  });

  it("names the node id in the changed path when one is present", () => {
    const before: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [{ kind: "card", id: "n_9", type: "generator-runs" }],
      },
    };
    expect(rewriteCardType(before, "generator-runs", "runs").changed).toEqual([
      "root.children[0] (n_9)",
    ]);
  });

  it("is a no-op when the type is absent — same doc by reference", () => {
    const before = docWithNestedCard("runs");
    const { doc, changed } = rewriteCardType(before, "generator-runs", "runs");
    expect(changed).toEqual([]);
    expect(doc).toBe(before);
  });

  it("is idempotent", () => {
    const first = rewriteCardType(
      docWithNestedCard("generator-runs"),
      "generator-runs",
      "runs",
    );
    const second = rewriteCardType(first.doc, "generator-runs", "runs");
    expect(second.changed).toEqual([]);
    expect(second.doc).toBe(first.doc);
  });

  it("rewrites every occurrence, not just the first", () => {
    const before: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [
          { kind: "card", type: "generator-runs" },
          {
            kind: "group",
            children: [{ kind: "card", type: "generator-runs" }],
          },
        ],
      },
    };
    expect(rewriteCardType(before, "generator-runs", "runs").changed).toEqual([
      "root.children[0]",
      "root.children[1].children[0]",
    ]);
  });

  it("clears the unknown-card-type warning the stale type produced", () => {
    const stale = normalizeDocV4(docWithNestedCard("generator-runs"));
    const staleResult = validateDocV4(stale);
    expect(staleResult.valid).toBe(true); // warn-not-reject: it persists, it just doesn't render
    expect(staleResult.warnings.map((w) => w.code)).toContain(
      "unknown-card-type",
    );

    const { doc } = rewriteCardType(stale, "generator-runs", "runs");
    const fixed = validateDocV4(doc);
    expect(fixed.valid).toBe(true);
    expect(fixed.warnings).toEqual([]);
  });
});
