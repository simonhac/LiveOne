/**
 * Exact-string cases for the CLI tree renderer — the output IS the interface (operators copy the
 * printed `n_…` ids into edit commands), so the shape is asserted literally.
 */
import { describe, it, expect } from "@jest/globals";
import { renderDocTree } from "../v4-tree-text";
import type { DashboardV4 } from "../v4";
import { Area } from "@/lib/ids";

const AREA = Area.generate();

function fixture(): DashboardV4 {
  return {
    version: 4,
    root: {
      id: "n_0",
      kind: "group",
      children: [
        {
          id: "n_1",
          kind: "group",
          direction: "row",
          wrap: true,
          heading: true,
          area: AREA,
          children: [
            { id: "n_2", kind: "card", type: "solar", size: { columns: 3 } },
            { id: "n_3", kind: "card", type: "battery", hidden: true },
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

describe("renderDocTree", () => {
  it("renders one indented line per node with annotations", () => {
    expect(renderDocTree(fixture())).toBe(
      [
        `  n_0  group`,
        `    n_1  group row wrap heading  area=${AREA}`,
        `      n_2  card solar  cols=3`,
        `      n_3  card battery  hidden`,
        `    n_4  card chart  config={"variant":"lines"}`,
      ].join("\n"),
    );
  });

  it("renders a subtree and applies markers", () => {
    const out = renderDocTree(fixture(), {
      nodeId: "n_1",
      markers: new Map([["n_3", "+"]]),
    });
    expect(out).toBe(
      [
        `  n_1  group row wrap heading  area=${AREA}`,
        `    n_2  card solar  cols=3`,
        `+   n_3  card battery  hidden`,
      ].join("\n"),
    );
  });

  it("labels an id-less node and truncates long config", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: {
        id: "n_0",
        kind: "group",
        children: [
          {
            kind: "card",
            type: "daily-stripe",
            config: {
              primary: { logicalPath: "load.hws/temperature" },
              days: 7,
              unit: "°C",
              label: "Faucet",
            },
          },
        ],
      },
    };
    const lines = renderDocTree(doc).split("\n");
    expect(lines[1]).toContain("(no id)");
    expect(lines[1]).toContain("…");
  });

  it("reports an unknown subtree id instead of throwing", () => {
    expect(renderDocTree(fixture(), { nodeId: "n_zz" })).toBe(
      '(no node "n_zz")',
    );
  });
});
