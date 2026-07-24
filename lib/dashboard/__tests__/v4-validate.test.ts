import { describe, it, expect } from "@jest/globals";
import { Area, Device, newUuidV7 } from "@/lib/ids";
import {
  validateDocV4,
  normalizeDocV4,
  collectRefs,
  DEPTH_CAP,
} from "../v4-validate";
import { walkNodes, type DashboardV4 } from "../v4";

const areaId = () => Area.encode(newUuidV7());
const deviceId = () => Device.encode(newUuidV7());

function validDoc(): DashboardV4 {
  return {
    version: 4,
    root: {
      kind: "group",
      children: [
        {
          kind: "group",
          area: areaId(),
          heading: true,
          children: [
            { kind: "card", type: "solar" },
            { kind: "card", type: "chart", config: { variant: "lines" } },
          ],
        },
      ],
    },
  };
}

describe("validateDocV4 — envelope", () => {
  it("accepts a well-formed doc and normalizes ids", () => {
    const r = validateDocV4(validDoc());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.normalized).toBeDefined();
    // every node has an id post-normalize
    let missing = 0;
    walkNodes(r.normalized!, (n) => {
      if (!n.id) missing++;
    });
    expect(missing).toBe(0);
  });

  it("rejects a wrong version", () => {
    const r = validateDocV4({ ...validDoc(), version: 3 });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects unknown keys (strict envelope)", () => {
    const doc = validDoc() as unknown as Record<string, unknown>;
    const r = validateDocV4({ ...doc, surprise: 1 });
    expect(r.valid).toBe(false);
  });

  it("rejects a malformed area ref", () => {
    const r = validateDocV4({
      version: 4,
      root: { kind: "group", area: "not-an-area-id", children: [] },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.includes("area"))).toBe(true);
  });
});

describe("validateDocV4 — type layering (§8.4)", () => {
  it("warns (does not reject) on an unknown card type, preserving it", () => {
    const r = validateDocV4({
      version: 4,
      root: {
        kind: "group",
        children: [{ kind: "card", type: "future-widget", config: { x: 1 } }],
      },
    });
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.code === "unknown-card-type")).toBe(true);
  });

  it("rejects bad config on a known type (chart missing variant)", () => {
    const r = validateDocV4({
      version: 4,
      root: {
        kind: "group",
        children: [{ kind: "card", type: "chart", config: {} }],
      },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.includes("config"))).toBe(true);
  });

  it("rejects config on a bare known type (sankey takes none)", () => {
    const r = validateDocV4({
      version: 4,
      root: {
        kind: "group",
        children: [{ kind: "card", type: "sankey", config: { extra: 1 } }],
      },
    });
    expect(r.valid).toBe(false);
  });

  it("accepts a bare known type with no config", () => {
    const r = validateDocV4({
      version: 4,
      root: { kind: "group", children: [{ kind: "card", type: "sankey" }] },
    });
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe("validateDocV4 — node-id uniqueness", () => {
  it("rejects duplicate supplied node ids (stable-key invariant)", () => {
    const r = validateDocV4({
      version: 4,
      root: {
        kind: "group",
        id: "n_x",
        children: [{ kind: "card", type: "solar", id: "n_x" }],
      },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "duplicate-node-id")).toBe(true);
  });
});

describe("validateDocV4 — depth cap", () => {
  it(`flags nodes deeper than DEPTH_CAP (${DEPTH_CAP})`, () => {
    // root(1) → group(2) → group(3) → group(4) → card(5): the card at depth 5 exceeds the cap of 4.
    const doc = {
      version: 4,
      root: {
        kind: "group",
        children: [
          {
            kind: "group",
            children: [
              {
                kind: "group",
                children: [
                  {
                    kind: "group",
                    children: [{ kind: "card", type: "solar" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const r = validateDocV4(doc);
    expect(r.errors.some((e) => e.code === "depth-exceeded")).toBe(true);
    expect(r.valid).toBe(false);
  });
});

describe("normalizeDocV4", () => {
  it("is idempotent and preserves existing ids", () => {
    const once = normalizeDocV4(validDoc());
    const twice = normalizeDocV4(once);
    expect(twice).toEqual(once);
  });

  it("mints ids that skip ids already present (no collision)", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: {
        id: "n_0", // deliberately collides with the mint counter's first candidate
        kind: "group",
        children: [{ kind: "card", type: "solar" }],
      },
    };
    const out = normalizeDocV4(doc);
    const ids = new Set<string>();
    walkNodes(out, (n) => ids.add(n.id!));
    expect(out.root.id).toBe("n_0"); // preserved
    expect(ids.size).toBe(2); // no collision → both nodes distinct
  });
});

describe("collectRefs — §8.3 envelope-only walk", () => {
  it("collects area/device from envelope positions but NEVER from config", () => {
    const a = areaId();
    const d = deviceId();
    const smuggled = areaId(); // a real area id, but hidden inside config
    const doc: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        area: a,
        children: [
          {
            kind: "card",
            type: "oe-grid",
            device: d,
            // scope-bearing string in config must be ignored by the resolver:
            config: { smuggledArea: smuggled } as unknown,
          },
        ],
      },
    };
    const refs = collectRefs(doc);
    expect(refs.areas).toEqual([a]);
    expect(refs.devices).toEqual([d]);
    expect(refs.areas).not.toContain(smuggled);
  });
});
