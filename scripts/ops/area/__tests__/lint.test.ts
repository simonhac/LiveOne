import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { areaCommand } from "../cli";
import { LINT_HANDLERS, lintTree, type LintFinding } from "../lint";
import type { TreeInventory } from "@/lib/inventory/types";

/**
 * `area lint` is a PURE function over one `/api/v4/tree` payload, which is the whole reason it was
 * built on the tree instead of on `loadAggregate` + `loadPointPool`. So these tests are fixtures,
 * not mocked networks.
 *
 * The central fixture is the fleet's real state at the time this was written: `Kinkora Rd` carried
 * the one surviving priority chain (`bidi.battery/soc` — Mondo@0 serving, Fronius@1 fallback), and
 * the bindings plan's verification step is that a census of serving keys with >1 wire returns zero
 * rows. That is the finding this verb exists to produce.
 */

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(areaCommand, argv, TTY, ["liveone"]);

function tree(over: Partial<TreeInventory> = {}): TreeInventory {
  return {
    version: 1,
    generatedAt: "2026-09-15T00:00:00.000Z",
    scope: "fleet",
    sharingIncluded: false,
    users: [],
    areas: [
      {
        id: "ar_kinkora",
        name: "Kinkora Rd",
        ownerId: "u1",
        status: "active",
        provenance: {
          batteryDays: 349,
          batteryLastDay: "2026-09-16",
          flowDays: 349,
          flowLastDay: "2026-09-16",
        },
      },
    ],
    devices: [
      {
        id: "dv_mondo",
        handle: 5,
        name: "Kinkora Mondo",
        vendor: "sigenergy",
        status: "active",
        ownerId: "u1",
        areaId: "ar_kinkora",
        history: { daily: null, lastSuccess: null },
      },
      {
        id: "dv_fronius",
        handle: 6,
        name: "Kinkora Fronius",
        vendor: "fusher",
        status: "active",
        ownerId: "u1",
        areaId: "ar_kinkora",
        history: { daily: null, lastSuccess: null },
      },
    ],
    points: [
      {
        id: "pt_mondo_soc",
        deviceId: "dv_mondo",
        name: "SoC",
        path: "battery/soc",
        logicalPath: "bidi.battery",
        metric: "soc",
        unit: "%",
        active: true,
        control: false,
      },
      {
        id: "pt_fronius_soc",
        deviceId: "dv_fronius",
        name: "SoC",
        path: "Body/Data/StateOfCharge",
        logicalPath: "bidi.battery",
        metric: "soc",
        unit: "%",
        active: true,
        control: false,
      },
    ],
    bindings: [
      {
        id: "bn_mondo",
        areaId: "ar_kinkora",
        role: "battery",
        metric: "soc",
        pointId: "pt_mondo_soc",
        priority: 0,
      },
      {
        id: "bn_fronius",
        areaId: "ar_kinkora",
        role: "battery",
        metric: "soc",
        pointId: "pt_fronius_soc",
        priority: 1,
      },
    ],
    derivations: [],
    automations: [],
    dashboards: [],
    ...over,
  } as TreeInventory;
}

const kinds = (f: LintFinding[]) => f.map((x) => x.kind);

describe("lintTree — the chain census", () => {
  it("finds the Kinkora bidi.battery/soc collision, naming both wires in priority order", () => {
    const found = lintTree(tree()).filter(
      (f) => f.kind === "serving-key-collision",
    );
    expect(found).toHaveLength(1);
    expect(found[0].areaName).toBe("Kinkora Rd");
    expect(found[0].detail).toBe(
      "bidi.battery/soc has 2 wires: Kinkora Mondo@0, Kinkora Fronius@1",
    );
    expect(found[0].refs).toEqual(["pt_mondo_soc", "pt_fronius_soc"]);
  });

  it("returns zero rows once one of the two wires is removed", () => {
    const t = tree();
    t.bindings = t.bindings.filter((b) => b.id !== "bn_mondo");
    expect(lintTree(t)).toEqual([]);
  });

  /**
   * 🛑 The contention set is the SERVING KEY, not the (role, metric) slot. A `load` slot
   * legitimately holds many circuits at once and every one of them serves; grouping by slot would
   * report the fleet's most ordinary wiring as broken.
   */
  it("does not flag several distinct paths sharing one (role, metric) slot", () => {
    const t = tree();
    t.points = [
      {
        ...t.points[0],
        id: "pt_hvac",
        logicalPath: "load.hvac",
        metric: "power",
      },
      { ...t.points[1], id: "pt_ev", logicalPath: "load.ev", metric: "power" },
    ];
    t.bindings = [
      {
        ...t.bindings[0],
        id: "bn_1",
        role: "load",
        metric: "power",
        pointId: "pt_hvac",
        priority: 0,
      },
      {
        ...t.bindings[1],
        id: "bn_2",
        role: "load",
        metric: "power",
        pointId: "pt_ev",
        priority: 1,
      },
    ];
    expect(kinds(lintTree(t))).not.toContain("serving-key-collision");
  });

  /**
   * 🛑 A binding whose point is absent from the payload is not a clean binding — it is one this
   * census could not see. The tree carries the points of devices the CALLER can read, and an owned
   * area may legitimately bind an ownerless public device. Skipping those silently is how a real
   * collision hides behind a "no findings" result, which is worse than reporting nothing.
   */
  it("reports an incomplete census rather than silently skipping an unseen point", () => {
    const t = tree();
    t.points = t.points.filter((p) => p.id !== "pt_fronius_soc");
    const f = lintTree(t);
    expect(kinds(f)).toContain("census-incomplete");
    // …and it must NOT then claim the remaining single wire is a clean serving key.
    expect(kinds(f)).not.toContain("serving-key-collision");
    expect(f.find((x) => x.kind === "census-incomplete")?.refs).toEqual([
      "pt_fronius_soc",
    ]);
  });

  /** A stemless point claims no path, so it can never contend — `servingKey` returns null. */
  it("never groups stemless points together", () => {
    const t = tree();
    t.points = t.points.map((p) => ({ ...p, logicalPath: null }));
    expect(kinds(lintTree(t))).not.toContain("serving-key-collision");
  });
});

describe("lintTree — membership and point state", () => {
  it("flags a binding whose point's device has left the area", () => {
    const t = tree();
    t.devices[1] = { ...t.devices[1], areaId: "ar_elsewhere" };
    const f = lintTree(t).filter((x) => x.kind === "departed-device");
    expect(f).toHaveLength(1);
    expect(f[0].refs).toEqual(["pt_fronius_soc", "dv_fronius"]);
  });

  /**
   * An AMBIENT device (`areaId: null`) is bound on purpose — `replaceBindings` permits it, and the
   * OpenElectricity NEM regions live there permanently. Flagging those would make the check cry
   * wolf on the fleet's most stable wiring.
   */
  it("does not flag an ambient (ownerless) device as departed", () => {
    const t = tree();
    t.devices[1] = { ...t.devices[1], areaId: null };
    expect(kinds(lintTree(t))).not.toContain("departed-device");
  });

  it("flags an archived member instead of failing on it", () => {
    const t = tree();
    t.devices[1] = { ...t.devices[1], status: "archived" };
    const f = lintTree(t).filter((x) => x.kind === "archived-member");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("is archived");
  });

  /**
   * The divergence the tree closes: the server ranks `points.active` AHEAD of priority, so an
   * inactive preferred point has already been demoted while `area role list` still prints it as
   * the one that serves. `chainRanks` cannot see this field; the tree can.
   */
  it("flags a bound point that is inactive", () => {
    const t = tree();
    t.points[0] = { ...t.points[0], active: false };
    const f = lintTree(t).filter((x) => x.kind === "inactive-bound-point");
    expect(f).toHaveLength(1);
    expect(f[0].refs).toEqual(["pt_mondo_soc"]);
  });

  it("flags an area that has derived rows but no member devices", () => {
    const t = tree();
    t.devices = [];
    t.bindings = [];
    const f = lintTree(t).filter((x) => x.kind === "area-without-devices");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("349 fold day(s)");
  });

  it("does not flag an empty area with nothing left behind", () => {
    const t = tree();
    t.devices = [];
    t.bindings = [];
    t.areas[0] = {
      ...t.areas[0],
      provenance: {
        batteryDays: 0,
        batteryLastDay: null,
        flowDays: 0,
        flowLastDay: null,
      },
    };
    expect(lintTree(t)).toEqual([]);
  });
});

describe("lintTree — scoping", () => {
  it("reports only the named area, while still reading the whole tree", () => {
    const t = tree();
    t.areas.push({
      ...t.areas[0],
      id: "ar_other",
      name: "Other",
    });
    t.devices.push({
      ...t.devices[0],
      id: "dv_other",
      handle: 9,
      areaId: "ar_other",
      status: "archived",
    });
    expect(lintTree(t, new Set(["ar_other"])).map((f) => f.areaId)).toEqual([
      "ar_other",
    ]);
  });
});

describe("area lint — parse contract", () => {
  it("dispatches on the full path under `area`", () => {
    const r = at(["lint", "--all"]);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.subcommandPath).toEqual(["lint"]);
    expect(Object.keys(LINT_HANDLERS)).toContain("lint");
  });

  /** Read-only: `mutates` is not declared, so the parser itself must refuse `--apply`. */
  it("rejects --apply", () => {
    expect(at(["lint", "--all", "--apply"]).ok).toBe(false);
  });

  it("accepts a repeated --kind", () => {
    const r = at([
      "lint",
      "--all",
      "--kind=serving-key-collision",
      "--kind=departed-device",
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.flags.kind).toEqual(["serving-key-collision", "departed-device"]);
  });
});
