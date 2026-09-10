/**
 * `liveone area devices` / `liveone area role` — the flag contract through the pure parser, plus the
 * two pieces of logic that decide whether a write is safe: point resolution and the slot rewrite.
 *
 * Handlers are not unit-tested here (HTTP behaviour lives in `lib/cli-kit/__tests__/http.test.ts`),
 * but the read-modify-write is, because it is the one thing in this domain whose failure is SILENT:
 * `PUT …/bindings` is a full replace, so a rewrite that forgets the untouched slots does not error —
 * it deletes them, and the area quietly stops rendering.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { areaCommand } from "../cli";
import { CliFailure } from "@/lib/cli/cli";
import {
  resolvePoint,
  rewriteSlot,
  type PointCandidate,
  type WireBinding,
} from "../wiring";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(areaCommand, argv, TTY, ["liveone"]);

const failure = (argv: string[]) => {
  const r = at(argv);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return JSON.stringify(r.error);
};
const success = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};

describe("the verb tree", () => {
  it("routes the two-level path, so `devices set` is not `role set`", () => {
    // Both end in "set". A dispatcher keyed on the last element sends a membership replace to the
    // binding writer — which, being a full replace, would wipe the area's bindings.
    expect(success(["devices", "set", "kew", "13"]).subcommandPath).toEqual([
      "devices",
      "set",
    ]);
    expect(
      success(["role", "set", "kew", "grid", "rate", "p"]).subcommandPath,
    ).toEqual(["role", "set"]);
  });

  it("keeps the read verbs read-only and the wiring verbs gated", () => {
    // `mutates` adds --apply; a read verb must not accept it, or "dry run" becomes meaningless.
    expect(failure(["list", "--apply"])).toMatch(/apply/);
    expect(
      success(["role", "set", "kew", "grid", "rate", "p", "--apply"]),
    ).toBeTruthy();
    expect(success(["devices", "add", "kew", "13", "--apply"])).toBeTruthy();
  });

  it("defaults a wiring verb to NOT writing", () => {
    expect(success(["role", "set", "kew", "grid", "rate", "p"]).dryRun).toBe(
      true,
    );
    expect(
      success(["role", "set", "kew", "grid", "rate", "p", "--apply"]).dryRun,
    ).toBe(false);
  });

  it("takes the whole priority order as variadic arguments", () => {
    // Priority is argument order, so the slot's fallback chain is one write, not three.
    const r = success([
      "role",
      "set",
      "kew",
      "grid",
      "rate",
      "a:x/rate",
      "b:y/rate",
      "c:z/rate",
    ]);
    expect(r.args.slice(3)).toEqual(["a:x/rate", "b:y/rate", "c:z/rate"]);
  });

  it("lets `role clear` take a role alone or a role and a metric", () => {
    expect(success(["role", "clear", "kew", "grid"]).args).toEqual([
      "kew",
      "grid",
    ]);
    expect(success(["role", "clear", "kew", "grid", "rate"]).args).toEqual([
      "kew",
      "grid",
      "rate",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("resolving a point against the area's pool", () => {
  const pool: PointCandidate[] = [
    {
      id: "pt_kutis_exp",
      logicalPath: "bidi.grid.export/energy",
      metricType: "energy",
      unit: "Wh",
      name: "Grid export",
      deviceId: "dv_kutis",
      deviceName: "Kutis",
    },
    {
      id: "pt_amber_exp",
      logicalPath: "bidi.grid.export/energy",
      metricType: "energy",
      unit: "Wh",
      name: "Grid export",
      deviceId: "dv_amber",
      deviceName: "Amber - CitiPower (6103034617)",
    },
    {
      id: "pt_amber_rate",
      logicalPath: "bidi.grid.import/rate",
      metricType: "rate",
      unit: "cents_kWh",
      name: "Grid import",
      deviceId: "dv_amber",
      deviceName: "Amber - CitiPower (6103034617)",
    },
  ];

  /** The structured failure, so an assertion pins the operator-facing fields not just `message`. */
  const refusal = (ref: string) => {
    try {
      resolvePoint(pool, ref);
    } catch (e) {
      if (e instanceof CliFailure) return e.detail;
      throw e;
    }
    throw new Error(`expected "${ref}" to be refused`);
  };

  it("refuses an ambiguous bare path instead of picking one", () => {
    // 🛑 The real case: a composite area where a Sigenergy meter and an Amber account BOTH offer
    // `bidi.grid.export/energy`. Picking whichever sorted first would bind the meter and leave the
    // cost attribution silently empty — indistinguishable from the bug being fixed.
    const d = refusal("bidi.grid.export/energy");
    expect(d.what).toMatch(/matches 2 points/);
    // Both candidates are named, so the fix is a copy-paste rather than a hunt.
    expect(d.why).toMatch(/Kutis/);
    expect(d.why).toMatch(/Amber/);
    expect(d.next).toMatch(/device:logicalPath/);
  });

  it("resolves the same path once a device qualifies it", () => {
    expect(resolvePoint(pool, "Amber:bidi.grid.export/energy").id).toBe(
      "pt_amber_exp",
    );
    expect(resolvePoint(pool, "Kutis:bidi.grid.export/energy").id).toBe(
      "pt_kutis_exp",
    );
  });

  it("takes a pt_ id verbatim", () => {
    expect(resolvePoint(pool, "pt_amber_rate").id).toBe("pt_amber_rate");
  });

  it("resolves an unambiguous bare path", () => {
    expect(resolvePoint(pool, "bidi.grid.import/rate").id).toBe(
      "pt_amber_rate",
    );
  });

  it("says the point is not on the AREA, not merely 'not found'", () => {
    // The distinction is the fix: a point that exists but whose device is not a member is an
    // `area devices add` away, and the message has to say so or the operator hunts a typo.
    const d = refusal("nope/power");
    expect(d.what).toMatch(/area/i);
    expect(d.next).toMatch(/area devices add/);
  });
});

// ---------------------------------------------------------------------------

describe("rewriting one slot", () => {
  const current: WireBinding[] = [
    {
      role: "battery",
      metricType: "soc",
      pointId: "pt_soc",
      priority: 0,
      transform: null,
    },
    {
      role: "grid",
      metricType: "power",
      pointId: "pt_gp",
      priority: 0,
      transform: null,
    },
    {
      role: "grid",
      metricType: "rate",
      pointId: "pt_old",
      priority: 0,
      transform: null,
    },
    {
      role: "solar",
      metricType: "power",
      pointId: "pt_sp",
      priority: 0,
      transform: "x2",
    },
  ];

  it("keeps every other slot — the whole safety property", () => {
    const next = rewriteSlot(current, "grid", "rate", ["pt_a", "pt_b"]);
    // 4 - 1 replaced + 2 new
    expect(next).toHaveLength(5);
    for (const keep of ["pt_soc", "pt_gp", "pt_sp"])
      expect(next.some((b) => b.pointId === keep)).toBe(true);
  });

  it("replaces only the named slot, not the whole role", () => {
    // `grid/power` and `grid/rate` are different slots; touching one must not disturb the other.
    const next = rewriteSlot(current, "grid", "rate", ["pt_a"]);
    expect(
      next.filter((b) => b.role === "grid" && b.metricType === "power"),
    ).toHaveLength(1);
    expect(
      next.filter((b) => b.role === "grid" && b.metricType === "rate"),
    ).toHaveLength(1);
    expect(next.find((b) => b.metricType === "rate")!.pointId).toBe("pt_a");
  });

  it("numbers priority from argument order", () => {
    const next = rewriteSlot(current, "grid", "rate", ["pt_a", "pt_b", "pt_c"]);
    const slot = next
      .filter((b) => b.role === "grid" && b.metricType === "rate")
      .sort((a, b) => a.priority - b.priority);
    expect(slot.map((b) => [b.pointId, b.priority])).toEqual([
      ["pt_a", 0],
      ["pt_b", 1],
      ["pt_c", 2],
    ]);
  });

  it("carries an untouched binding's transform through", () => {
    // `transform` is per-binding state this CLI never sets. A rewrite that dropped it would
    // un-transform a slot nobody asked about, and nothing would report it.
    const next = rewriteSlot(current, "grid", "rate", ["pt_a"]);
    expect(next.find((b) => b.pointId === "pt_sp")!.transform).toBe("x2");
  });
});
