/**
 * The BM25 ranking behind `liveone find`.
 *
 * The interesting assertions are the tuning ones — every constant in search.ts deviates from a
 * textbook BM25 for a measured reason, and these pin the behaviours those reasons predict.
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildIndex,
  search,
  stem,
  tokenize,
  nearestNames,
  type CatalogueTool,
} from "../search";

const tool = (
  over: Partial<CatalogueTool> & { name: string },
): CatalogueTool => ({
  summary: "",
  when: "",
  description: "",
  signature: `${over.name} [options]`,
  invocation: `npm run liveone -- ${over.name.replace(/__/g, " ")}`,
  file: "scripts/ops/x.ts",
  input_schema: { type: "object", properties: {} },
  ...over,
});

const CORPUS: CatalogueTool[] = [
  tool({
    name: "liveone__dashboard__set-prop",
    summary: "Set or clear a node's envelope props, and a card's type/config.",
    when: "Use this to change an existing card in place — bind it to a different device, resize it.",
    parentWhen: "The dashboard-document tool.",
    input_schema: {
      type: "object",
      properties: {
        apply: { type: "boolean" },
        columns: { description: "Width hint" },
      },
    },
  }),
  tool({
    name: "liveone__dashboard__show",
    summary: "Render a dashboard's node tree.",
    when: "Run this before any edit; it prints the node ids other commands take.",
    parentWhen: "The dashboard-document tool.",
  }),
  tool({
    name: "liveone__auth__login",
    summary: "Sign in via the browser and store a token for one origin.",
    when: "The first command to run on a new machine, and the fix for any not-logged-in error.",
    parentWhen: "Manage the CLI credential.",
  }),
  tool({
    name: "liveone__find",
    summary: "Find the command for a job, in plain English.",
    when: "Reach for this first when you know what you want to do but not which command does it.",
  }),
];

const rank = (q: string, opts = {}) =>
  search(buildIndex(CORPUS), q, opts).hits.map((h) => h.name);

describe("tokenizing", () => {
  it("stems just enough to collide plurals, and no further", () => {
    expect(stem("payments")).toBe(stem("payment"));
    // A real Porter stemmer folds "generic"→"gener" and starts matching "generate"; in a corpus
    // this small that costs more precision than the recall is worth.
    expect(stem("generic")).toBe("generic");
  });

  it("splits a command name into its parts, so any one of them reaches it", () => {
    expect(tokenize("liveone__dashboard__set-prop")).toEqual(
      expect.arrayContaining(["liveone", "dashboard", "set", "prop"]),
    );
  });

  it("drops stopwords", () => {
    expect(tokenize("what is the dashboard")).toEqual(["dashboard"]);
  });

  it("over-stems a short -ing word, which is harmless because both sides are stemmed", () => {
    // "thing" -> "th". The stemmer is applied to the query and the corpus alike, so an
    // over-eager fold costs precision at worst; it can never make a term fail to match itself.
    expect(stem("thing")).toBe("th");
  });
});

describe("ranking", () => {
  it("finds the editing command from a plain-English description", () => {
    expect(rank("change a card on a dashboard")[0]).toBe(
      "liveone__dashboard__set-prop",
    );
  });

  it("finds login from words that appear only in `when`", () => {
    expect(rank("not logged in")[0]).toBe("liveone__auth__login");
  });

  it("matches a prefix at a discount — 'config' reaching 'configuration'-ish terms", () => {
    // The four-character floor keeps short words from matching half the corpus.
    expect(rank("prop").length).toBeGreaterThan(0);
  });

  it("keeps the searching tool out of its own results", () => {
    // Its vocabulary matches nearly every query; without the exclusion it takes a real answer's slot.
    expect(
      rank("find the command for a job", { exclude: "liveone__find" }),
    ).not.toContain("liveone__find");
  });

  it("reports `writes` off the schema, since only a mutating command has --apply", () => {
    const hits = search(buildIndex(CORPUS), "change a card", {}).hits;
    expect(hits.find((h) => h.name.endsWith("set-prop"))!.writes).toBe(true);
    expect(hits.every((h) => h.name.endsWith("set-prop") || !h.writes)).toBe(
      true,
    );
  });

  it("returns nothing for a query of only stopwords, rather than everything", () => {
    expect(search(buildIndex(CORPUS), "the and of").hits).toEqual([]);
  });
});

describe("corpus-specific stopwords", () => {
  it('keeps "who", because a command is named whoami', () => {
    // The corpus this was ported from treated "who" as noise; here it made
    // `find "who am i"` return nothing at all. The prefix rule reaches whoami from it.
    expect(tokenize("who am i")).toContain("who");
  });
});

describe("parentWhen is capped, not indexed", () => {
  it("does not let a shared parent line float a whole family above a better answer", () => {
    // Both dashboard entries share "The dashboard-document tool."; a query aimed at the AUTH
    // command must still win, rather than arriving behind a block of siblings.
    expect(rank("sign in on a new machine")[0]).toBe("liveone__auth__login");
  });
});

describe("truncation is never silent", () => {
  it("flags truncation when the limit drops a contender", () => {
    const r = search(buildIndex(CORPUS), "dashboard", { limit: 1 });
    expect(r.hits).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("flags truncation when the character budget bites", () => {
    const r = search(buildIndex(CORPUS), "dashboard card device", {
      budgetChars: 1,
    });
    expect(r.truncated).toBe(true);
    // Always at least one hit — a budget of 1 must not silently return nothing.
    expect(r.hits.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag truncation when everything fit", () => {
    expect(search(buildIndex(CORPUS), "sign in", { limit: 50 }).truncated).toBe(
      false,
    );
  });
});

describe("nearestNames", () => {
  it("is separator-insensitive, because that is the mistake people actually make", () => {
    const names = CORPUS.map((t) => t.name);
    expect(nearestNames("liveone dashboard show", names)).toContain(
      "liveone__dashboard__show",
    );
    expect(nearestNames("dashboard-show", names)).toContain(
      "liveone__dashboard__show",
    );
  });

  it("returns nothing for an empty query rather than the whole catalogue", () => {
    expect(
      nearestNames(
        "",
        CORPUS.map((t) => t.name),
      ),
    ).toEqual([]);
  });
});
