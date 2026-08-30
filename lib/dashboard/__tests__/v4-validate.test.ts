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
    expect(r.normalized?.root.children[0]).toMatchObject({
      type: "future-widget",
      config: { x: 1 },
    });
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
    // Under the random minter this is a REAL regeneration alarm: if normalize re-minted anything,
    // the second pass could not reproduce the first pass's ids (it could under the old counter).
    const once = normalizeDocV4(validDoc());
    const twice = normalizeDocV4(once);
    expect(twice).toEqual(once);
  });

  it("never touches a fully-idded doc", () => {
    const doc = normalizeDocV4(validDoc()); // every node now carries an id
    expect(normalizeDocV4(doc)).toEqual(doc);
  });

  it("mints n_XXXX (Crockford base32) and skips ids already present", () => {
    // Force the first candidate to collide with a supplied id: the retry loop must skip it.
    const candidates = ["n_TAKE", "n_TAKE", "n_FRE5"];
    const doc: DashboardV4 = {
      version: 4,
      root: {
        id: "n_TAKE", // deliberately collides with the injected minter's first candidates
        kind: "group",
        children: [{ kind: "card", type: "solar" }],
      },
    };
    const out = normalizeDocV4(doc, () => candidates.shift()!);
    expect(out.root.id).toBe("n_TAKE"); // preserved
    expect((out.root.children[0] as { id?: string }).id).toBe("n_FRE5"); // retried past the collision

    // And the production minter's format: 4 chars, no I/L/O/U.
    const minted = normalizeDocV4(validDoc());
    walkNodes(minted, (n) => {
      expect(n.id).toMatch(/^n_[0-9A-HJKMNP-TV-Z]{4}$/);
    });
  });

  it("mints distinct ids at volume (retry loop under the real RNG)", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: Array.from({ length: 1000 }, () => ({
          kind: "card" as const,
          type: "solar",
        })),
      },
    };
    const ids = new Set<string>();
    walkNodes(normalizeDocV4(doc), (n) => ids.add(n.id!));
    expect(ids.size).toBe(1001); // root + 1000 cards, all distinct
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
