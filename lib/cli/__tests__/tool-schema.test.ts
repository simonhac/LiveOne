/**
 * `CommandSpec` → MCP/Anthropic tool definition. This is the seam a future MCP server generates its
 * `tools/list` from, so the properties asserted here are the ones that would otherwise hand a model
 * an invocation that cannot run.
 */
import { describe, it, expect } from "@jest/globals";
import { defineCommand } from "../cli";
import {
  flattenCommands,
  inputSchemaFor,
  descriptionFor,
  signatureFor,
  toolNameFor,
  toolsFor,
} from "../tool-schema";

const leaf = defineCommand({
  name: "show",
  summary: "Render a thing.",
  when: "Reach for this to read; use `set` to change one.",
  args: [
    { name: "target", required: true, help: "What to show" },
    { name: "extra", variadic: true, help: "Anything else" },
  ],
  flags: {
    node: { type: "string", help: "A node id", placeholder: "n_id" },
    depth: { type: "number", default: 3, help: "How deep" },
    verbose: { type: "boolean", default: false, help: "More detail" },
    mode: { type: "string", values: ["a", "b"], help: "Which mode" },
    secret: { type: "boolean", help: "Hidden", hidden: true },
    allowUnknownType: { type: "boolean", help: "camelCase declaration" },
  },
  examples: ["dashboard show db_x"],
  uses: ["db"],
});

const tree = defineCommand({
  name: "dashboard",
  summary: "Edit dashboards.",
  when: "The dashboard-document tool.",
  uses: ["db"],
  subcommands: {
    show: leaf,
    apply: {
      name: "apply",
      summary: "Write a thing.",
      mutates: true,
      uses: ["api"],
    },
  },
});

describe("flattenCommands", () => {
  it("emits one tool per LEAF, never the bare parent", () => {
    // parse() exits 2 on a missing subcommand, so a tool for the bare parent would advertise a
    // command that cannot run.
    const flat = flattenCommands(tree);
    expect(flat.map((c) => c.path.join("__"))).toEqual([
      "dashboard__show",
      "dashboard__apply",
    ]);
  });

  it("inherits uses from the parent, but a child's own declaration wins", () => {
    const flat = flattenCommands(tree);
    expect(flat.find((c) => c.path[1] === "show")!.uses).toEqual(["db"]);
    expect(flat.find((c) => c.path[1] === "apply")!.uses).toEqual(["api"]);
  });

  it("keeps the parent's `when` in a SEPARATE field", () => {
    // Merging it into the child's would make every sibling identical on the highest-weighted
    // search field, so the family comes into contention and nothing can choose between them.
    const show = flattenCommands(tree)[0];
    expect(show.parentWhen).toBe("The dashboard-document tool.");
    expect(show.spec.when).toBe(
      "Reach for this to read; use `set` to change one.",
    );
  });

  it("treats a command with no subcommands as its own single leaf", () => {
    expect(flattenCommands(leaf).map((c) => c.path)).toEqual([["show"]]);
  });
});

describe("toolNameFor", () => {
  it("joins the path with __ and rejects anything outside Anthropic's charset", () => {
    expect(toolNameFor(["dashboard", "set-prop"])).toBe("dashboard__set-prop");
    expect(() => toolNameFor(["bad name"])).toThrow(/charset/);
    expect(() => toolNameFor(["x".repeat(65)])).toThrow(/charset/);
  });
});

describe("inputSchemaFor", () => {
  const schema = inputSchemaFor(leaf);

  it("names flags in KEBAB, because that is what gets typed", () => {
    // Emitting the camelCase declaration key would hand the agent an invocation that exits 2.
    expect(schema.properties["allow-unknown-type"]).toBeDefined();
    expect(schema.properties.allowUnknownType).toBeUndefined();
  });

  it("types positionals, variadics, enums and repeatables correctly", () => {
    expect(schema.properties.target).toEqual({
      type: "string",
      description: "What to show",
    });
    expect(schema.properties.extra).toEqual({
      type: "array",
      items: { type: "string" },
      description: "Anything else",
    });
    expect(schema.properties.mode.enum).toEqual(["a", "b"]);
    expect(schema.required).toEqual(["target"]);
  });

  it("emits a declared default even when it is false", () => {
    // `!== undefined`, not truthiness — otherwise a false default reads as "no default".
    expect(schema.properties.verbose.default).toBe(false);
    expect(schema.properties.depth.default).toBe(3);
  });

  it("folds placeholder and hint into the property description", () => {
    expect(schema.properties.node.description).toBe("A node id (n_id)");
  });

  it("omits hidden flags", () => {
    expect(schema.properties.secret).toBeUndefined();
  });

  it("emits --format always, but --apply/--yes only for a mutating command", () => {
    expect(schema.properties.format.enum).toEqual(["human", "json"]);
    expect(schema.properties.apply).toBeUndefined();
    const writer = inputSchemaFor({
      name: "w",
      summary: "s",
      mutates: true,
    });
    expect(writer.properties.apply.type).toBe("boolean");
    expect(writer.properties.yes.type).toBe("boolean");
  });

  it("emits the declared format set for a csv-capable command", () => {
    const csvCapable = inputSchemaFor({
      name: "downloader",
      summary: "s",
      formats: ["human", "json", "csv"],
    });
    expect(csvCapable.properties.format.enum).toEqual(["human", "json", "csv"]);
  });

  it("THROWS when a positional and a flag claim the same name", () => {
    // JSON Schema has one namespace and a CLI has two; the alternative is one silently
    // overwriting the other and the agent never learning which.
    expect(() =>
      inputSchemaFor({
        name: "clash",
        summary: "s",
        args: [{ name: "mode", help: "positional" }],
        flags: { mode: { type: "string", help: "flag" } },
      }),
    ).toThrow(/claimed twice/);
  });
});

describe("descriptionFor", () => {
  const [show, apply] = flattenCommands(tree);

  it("leads with the invocation, then the trigger conditions", () => {
    const d = descriptionFor(show, { file: "scripts/ops/dashboard.ts" });
    const lines = d.split("\n\n");
    expect(lines[0]).toBe("npm run dashboard -- show — Render a thing.");
    expect(lines[1]).toBe("Reach for this to read; use `set` to change one.");
    expect(d).toContain(
      "About `dashboard` generally: The dashboard-document tool.",
    );
  });

  it("states the write posture explicitly on both kinds", () => {
    expect(descriptionFor(show, { file: "f" })).toContain("Read-only.");
    const d = descriptionFor(apply, { file: "f" });
    expect(d).toContain("WRITES. Dry by default");
    expect(d).toContain("--apply additionally requires --yes");
  });

  it("names the systems it reaches and the exit codes it can produce", () => {
    expect(descriptionFor(show, { file: "f" })).toContain(
      "Connects DIRECTLY to Postgres",
    );
    expect(descriptionFor(apply, { file: "f" })).toContain(
      "revoked CLI token is exit 3",
    );
    expect(descriptionFor(show, { file: "f" })).toContain(
      "Exit codes: 0, 1, 2, 5, 130.",
    );
  });

  it("emits examples verbatim", () => {
    expect(descriptionFor(show, { file: "f" })).toContain(
      "  dashboard show db_x",
    );
  });
});

describe("signatureFor", () => {
  it("renders a compact, bounded one-liner without the globals", () => {
    const sig = signatureFor(flattenCommands(tree)[0], 500);
    expect(sig).toContain("dashboard show <target> [extra...]");
    expect(sig).toContain('--mode?: "a"|"b"');
    expect(sig).toContain("--depth?: number");
    expect(sig).not.toContain("--format");
    expect(sig).not.toContain("--secret"); // hidden
  });

  it("truncates past the budget with an ellipsis", () => {
    const sig = signatureFor(flattenCommands(tree)[0], 40);
    expect(sig.length).toBeLessThanOrEqual(40);
    expect(sig.endsWith("…")).toBe(true);
  });
});

describe("toolsFor", () => {
  it("produces exactly the three members Anthropic's format defines", () => {
    const tools = toolsFor(tree, { file: "scripts/ops/dashboard.ts" });
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      expect(Object.keys(t).sort()).toEqual([
        "description",
        "input_schema",
        "name",
      ]);
      expect(t.input_schema.type).toBe("object");
    }
  });
});
