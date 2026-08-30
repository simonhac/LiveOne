/**
 * The `find` verb — the catalogue-reading half. The ranking itself is tested in
 * lib/cli/__tests__/search.test.ts; what matters here is that the committed catalogue is real and
 * answers the questions find's own help text promises it answers.
 */
import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { buildIndex, search, type CatalogueTool } from "@/lib/cli/search";
import { findCommand } from "../cli";
import { parse, type Tty } from "@/lib/cli/cli";

const catalogue = (): CatalogueTool[] =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "docs/cli-tools.json"), "utf8"),
  ).tools;

describe("the committed catalogue", () => {
  it("contains find itself, so discovery is discoverable", () => {
    expect(catalogue().map((t) => t.name)).toContain("liveone__find");
  });

  it("answers the questions find's help text promises it answers", () => {
    const ix = buildIndex(catalogue());
    const top = (q: string) =>
      search(ix, q, { exclude: "liveone__find", limit: 6 }).hits.map(
        (h) => h.name,
      );
    expect(top("edit a dashboard card")[0]).toMatch(/^liveone__dashboard__/);
    expect(top("log in")[0]).toBe("liveone__auth__login");
    expect(top("who am i")[0]).toBe("liveone__auth__whoami");
    expect(top("what changed and when")).toContain(
      "liveone__dashboard__history",
    );
  });
});

describe("flag validation", () => {
  const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
  const at = (argv: string[]) => parse(findCommand, argv, TTY, ["liveone"]);
  const failure = (argv: string[]) => {
    const r = at(argv);
    if (r.ok) throw new Error("expected a usage error, got ok");
    return r.error;
  };
  const success = (argv: string[]) => {
    const r = at(argv);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
    return r;
  };

  it("rejects a non-positive limit rather than quietly returning nothing", () => {
    expect(JSON.stringify(failure(["--limit=0", "cards"]))).toMatch(/limit/i);
  });

  it("rejects a non-numeric budget", () => {
    expect(JSON.stringify(failure(["--budget=lots", "cards"]))).toMatch(
      /budget/i,
    );
  });

  it("collects the query as variadic positionals", () => {
    expect(success(["edit", "a", "card"]).args).toEqual(["edit", "a", "card"]);
  });
});
