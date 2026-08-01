import { describe, it, expect } from "@jest/globals";
import { Area, Device, newUuidV7 } from "@/lib/ids";
import {
  resolveNodeContexts,
  resolveDashboardShell,
  type ShellResolver,
} from "../resolve-shell";
import type { DashboardV4 } from "../v4";

const aId = () => Area.encode(newUuidV7());
const dId = () => Device.encode(newUuidV7());

describe("resolveNodeContexts — §8.1 inheritance", () => {
  it("inherits the nearest ancestor's area/device; own binding overrides", () => {
    const A = aId();
    const D = dId();
    const Dcard = dId();
    const doc: DashboardV4 = {
      version: 4,
      root: {
        id: "n_root",
        kind: "group",
        children: [
          {
            id: "n_sec",
            kind: "group",
            area: A,
            heading: true,
            children: [
              {
                id: "n_row",
                kind: "group",
                direction: "row",
                device: D,
                children: [
                  { id: "n_c1", kind: "card", type: "solar" }, // inherits A + D
                  { id: "n_c2", kind: "card", type: "oe-grid", device: Dcard }, // own device wins
                ],
              },
              { id: "n_c3", kind: "card", type: "sankey" }, // inherits A, no device
            ],
          },
        ],
      },
    };
    const ctx = new Map(
      resolveNodeContexts(doc).map((e) => [e.node.id, e.context]),
    );
    expect(ctx.get("n_root")).toEqual({ area: undefined, device: undefined });
    expect(ctx.get("n_sec")).toEqual({ area: A, device: undefined });
    expect(ctx.get("n_row")).toEqual({ area: A, device: D });
    expect(ctx.get("n_c1")).toEqual({ area: A, device: D });
    expect(ctx.get("n_c2")).toEqual({ area: A, device: Dcard });
    expect(ctx.get("n_c3")).toEqual({ area: A, device: undefined });
  });
});

describe("resolveDashboardShell", () => {
  it("resolves refs, dedups data handles, tracks dangling refs, and caches lookups", () => {
    const A1 = aId();
    const A2 = aId();
    const Adangling = aId();
    const D1 = dId();
    const doc: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [
          {
            kind: "group",
            area: A1,
            heading: true,
            children: [
              { kind: "card", type: "solar" },
              { kind: "card", type: "runs", device: D1 },
            ],
          },
          // A1 again → the area lookup must be cached and the handle deduped
          {
            kind: "group",
            area: A1,
            heading: true,
            children: [{ kind: "card", type: "sankey" }],
          },
          {
            kind: "group",
            area: A2,
            heading: true,
            children: [{ kind: "card", type: "amber-now" }],
          },
          // dangling area → resolver returns null → no handle, recorded as dangling
          {
            kind: "group",
            area: Adangling,
            heading: true,
            children: [{ kind: "card", type: "solar" }],
          },
        ],
      },
    };

    const handles: Record<string, number> = { [A1]: 10, [A2]: 20 };
    let areaCalls = 0;
    let deviceCalls = 0;
    const resolver: ShellResolver = {
      area: (id) => {
        areaCalls++;
        if (id === Adangling) return null;
        return {
          areaId: id,
          displayName: `Area ${id.slice(0, 6)}`,
          handle: handles[id],
          chartCapable: true,
        };
      },
      device: (id) => {
        deviceCalls++;
        return { deviceId: id, name: "Generator", systemId: 14 };
      },
    };

    const shell = resolveDashboardShell(doc, resolver);

    // pre-order: A1(10) → D1(14) → A2(20); the dangling area contributes no handle.
    expect(shell.dataHandles).toEqual([10, 14, 20]);
    expect(shell.danglingAreas).toEqual([Adangling]);
    expect(shell.danglingDevices).toEqual([]);
    // each distinct ref resolved exactly once (A1 requested by 5 nodes → 1 call)
    expect(areaCalls).toBe(3);
    expect(deviceCalls).toBe(1);

    // per-node resolved bindings
    const solar = shell.nodes.find(
      (n) => n.node.kind === "card" && n.node.type === "solar",
    )!;
    expect(solar.area?.handle).toBe(10);
    const dangCard = shell.nodes.find((n) => n.context.area === Adangling);
    expect(dangCard?.area).toBeNull();
  });

  it("handles an empty doc", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: { kind: "group", children: [] },
    };
    const resolver: ShellResolver = { area: () => null, device: () => null };
    const shell = resolveDashboardShell(doc, resolver);
    expect(shell.dataHandles).toEqual([]);
    expect(shell.nodes).toHaveLength(1); // just the root
    expect(shell.danglingAreas).toEqual([]);
  });
});
