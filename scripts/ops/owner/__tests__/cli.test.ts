/**
 * The `owner` domain's flag contract, and the doc-ref scan the transfer plan depends on.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { ownerCommand } from "../index";
import { csv, scanDocRefs } from "../model";
import { ownerOf } from "../handlers";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(ownerCommand, argv, TTY, ["liveone"]);
const ok = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};
const bad = (argv: string[]) => {
  const r = at(argv);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return JSON.stringify(r.error);
};

describe("the transfer contract", () => {
  it("does not write without --apply", () => {
    expect(ok(["transfer", "karoline", "--areas=kutis"]).dryRun).toBe(true);
    expect(
      ok(["transfer", "karoline", "--areas=kutis", "--apply"]).dryRun,
    ).toBe(false);
  });

  it("keeps `show` read-only", () => {
    expect(bad(["show", "kutis", "--apply"])).toMatch(/apply/);
  });

  it("refuses a role that is not a grant role", () => {
    // 'owner' is a plausible thing to type and is NOT a dashboard_grants role (the check constraint
    // is admin|viewer); catching it here beats a 422 from the far end of a transfer.
    expect(bad(["transfer", "k", "--areas=a", "--role=owner"])).toMatch(/role/);
    expect(ok(["transfer", "k", "--areas=a", "--role=admin"])).toBeTruthy();
    expect(ok(["transfer", "k", "--areas=a", "--role=viewer"])).toBeTruthy();
  });
});

describe("csv refs", () => {
  it("ignores whitespace and empty entries", () => {
    expect(csv("a, b ,, c ")).toEqual(["a", "b", "c"]);
    expect(csv(undefined)).toEqual([]);
    expect(csv("")).toEqual([]);
  });
});

describe("scanning a dashboard doc for refs", () => {
  it("finds area and device refs at any depth", () => {
    const doc = {
      root: {
        children: [
          {
            type: "group",
            children: [{ type: "card", area: "ar_" + "a".repeat(26) }],
          },
          { type: "card", tiles: [{ device: "dv_" + "b".repeat(26) }] },
        ],
      },
    };
    expect([...scanDocRefs(doc)]).toEqual(
      expect.arrayContaining(["ar_" + "a".repeat(26), "dv_" + "b".repeat(26)]),
    );
  });

  it("does NOT match an id that merely appears inside another field", () => {
    // 🛑 The reason this walks keys instead of grepping the serialised doc: an id in a label or a
    // saved query is not a reference, and treating it as one would put an unrelated dashboard in
    // the transfer plan.
    const doc = {
      root: {
        title: "see ar_" + "a".repeat(26) + " for details",
        note: "dv_" + "b".repeat(26),
      },
    };
    expect([...scanDocRefs(doc)]).toEqual([]);
  });

  it("ignores a malformed ref rather than half-matching it", () => {
    expect([...scanDocRefs({ card: { area: "ar_nope" } })]).toEqual([]);
    expect([...scanDocRefs({ card: { area: 42 } })]).toEqual([]);
  });

  it("survives nulls and arrays without throwing", () => {
    expect([...scanDocRefs(null)]).toEqual([]);
    expect([
      ...scanDocRefs([null, { device: "dv_" + "c".repeat(26) }]),
    ]).toEqual(["dv_" + "c".repeat(26)]);
  });
});

describe("reading an owner off an aggregate", () => {
  it("keeps 'no owner' and 'not reported' apart", () => {
    // 🛑 These mean opposite things. `null` is OWNERLESS, which is public-read
    // (`requireDeviceAccess`: `isPublic = ownerUserId == null`). `undefined` is a deployment that
    // does not carry the field. Collapsing them made `owner show` report every area on prod as
    // "ownerless — public read" — an alarming and entirely false security finding.
    expect(ownerOf({ ownerUserId: null })).toEqual({
      ownerUserId: null,
      ownerKnown: true,
    });
    expect(ownerOf({})).toEqual({ ownerUserId: null, ownerKnown: false });
  });

  it("reads a present owner", () => {
    expect(ownerOf({ ownerUserId: "user_x" })).toEqual({
      ownerUserId: "user_x",
      ownerKnown: true,
    });
  });
});
