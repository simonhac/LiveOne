/**
 * config-v4 dashboard document validation + normalization (clean-sheet §8.4).
 *
 * Layered posture:
 *   1. Envelope: STRICT (zod). Malformed structure ⇒ `valid:false` with issues (the route maps to 422,
 *      persists nothing). Unknown keys are rejected (strictObject).
 *   2. `type`: OPEN string, warn-not-reject. An unknown card type persists with opaque config and
 *      yields a WARNING (a newer client/agent must not have its config destroyed by an older validator).
 *   3. Known types: STRICT per-type `config` schema (card-types.ts).
 *   4. References: format-STRICT here (`area` must be `ar_…`, `device` `dv_…`); EXISTENCE + readability
 *      is an async DB check the Phase-6 route layers on top, over `collectRefs` (§8.3 — one walk).
 *
 * `normalizeDocV4` assigns every node a stable `n_…` id idempotently (generalizes v3
 * `normalizeDescriptor`). `collectRefs` is the single type-agnostic scope walk over the fixed envelope
 * positions (`node.area` / `node.device`) — the §8.3 security invariant made executable.
 *
 * PURE + DARK: no DB, no React; nothing calls this in the live path yet.
 */
import { z } from "zod";
import { Area, Device } from "@/lib/ids";
import type { AreaId, DeviceId } from "@/lib/ids";
import { isKnownCardType, CARD_CONFIG_SCHEMAS } from "./card-types";
import {
  type DashboardV4,
  type DashboardNode,
  type GroupNode,
  walkNodes,
} from "./v4";

/** Depth cap (clean-sheet §8.1/§15): root is depth 1. */
export const DEPTH_CAP = 4;

export interface DocIssue {
  path: string; // dotted/bracketed position, e.g. "root.children[0].config.variant"
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: DocIssue[];
  warnings: DocIssue[];
  /** The normalized (id-assigned) doc — present whenever the envelope parses, for dry-run preview.
   *  Only persist it when `valid` (no errors). */
  normalized?: DashboardV4;
}

// ---------------------------------------------------------------------------
// Envelope schema (structural / strict). `type` stays open; per-type config is checked separately.
// Recursion via a lazy union declared first so `groupNodeSchema.children` can reference it eagerly.
// ---------------------------------------------------------------------------
const nodeIdSchema = z.string().min(1);
const nodeSizeSchema = z.strictObject({
  columns: z.number().int().min(1).max(12).optional(),
});
const areaRefSchema = z
  .string()
  .refine((s) => Area.is(s), { message: "invalid area id (expected ar_…)" });
const deviceRefSchema = z
  .string()
  .refine((s) => Device.is(s), {
    message: "invalid device id (expected dv_…)",
  });

// Declared first: the lazy union references group/card (defined below) only when parsing runs.
const nodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("kind", [groupNodeSchema, cardNodeSchema]),
);

const cardNodeSchema = z.strictObject({
  id: nodeIdSchema.optional(),
  kind: z.literal("card"),
  type: z.string().min(1), // open string (§8.4); known-set check is in the semantic pass
  area: areaRefSchema.optional(),
  device: deviceRefSchema.optional(),
  hidden: z.boolean().optional(),
  size: nodeSizeSchema.optional(),
  config: z.unknown().optional(), // validated per-type in the semantic pass
});

const groupNodeSchema = z.strictObject({
  id: nodeIdSchema.optional(),
  kind: z.literal("group"),
  area: areaRefSchema.optional(),
  device: deviceRefSchema.optional(),
  direction: z.enum(["row", "column"]).optional(),
  wrap: z.boolean().optional(),
  heading: z.boolean().optional(),
  hidden: z.boolean().optional(),
  size: nodeSizeSchema.optional(),
  children: z.array(nodeSchema),
});

const docSchema = z.strictObject({
  version: z.literal(4),
  root: groupNodeSchema,
});

/** A known type with no dedicated config schema is BARE: it must carry no config (empty object ok). */
const emptyConfigSchema = z.strictObject({});

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      const s = typeof seg === "symbol" ? seg.toString() : seg;
      out += out ? `.${s}` : s;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Semantic pass: depth cap + per-type config + unknown-type warnings.
// ---------------------------------------------------------------------------
function semanticCheck(doc: DashboardV4): {
  errors: DocIssue[];
  warnings: DocIssue[];
} {
  const errors: DocIssue[] = [];
  const warnings: DocIssue[] = [];
  // Node ids are the stable drag-drop / undo-reconciliation keys, so supplied ids must be unique.
  // normalizeDocV4 cannot renumber a duplicate without breaking that stable-key contract, so the
  // validator rejects here (persist only when valid).
  const seenIds = new Set<string>();

  const recur = (node: DashboardNode, path: string, depth: number): void => {
    if (depth > DEPTH_CAP) {
      errors.push({
        path,
        code: "depth-exceeded",
        message: `node depth ${depth} exceeds cap ${DEPTH_CAP}`,
      });
    }
    if (node.id !== undefined) {
      if (seenIds.has(node.id)) {
        errors.push({
          path: `${path}.id`,
          code: "duplicate-node-id",
          message: `duplicate node id "${node.id}" — node ids must be unique`,
        });
      } else {
        seenIds.add(node.id);
      }
    }
    if (node.kind === "card") {
      if (!isKnownCardType(node.type)) {
        warnings.push({
          path: `${path}.type`,
          code: "unknown-card-type",
          message: `unknown card type "${node.type}" preserved with opaque config`,
        });
      } else {
        const schema = CARD_CONFIG_SCHEMAS[node.type] ?? emptyConfigSchema;
        const r = schema.safeParse(node.config ?? {});
        if (!r.success) {
          for (const iss of r.error.issues) {
            errors.push({
              path: `${path}.config${iss.path.length ? "." : ""}${formatPath(iss.path)}`,
              code: iss.code,
              message: iss.message,
            });
          }
        }
      }
    } else {
      node.children.forEach((child, i) =>
        recur(child, `${path}.children[${i}]`, depth + 1),
      );
    }
  };

  recur(doc.root, "root", 1);
  return { errors, warnings };
}

/**
 * Validate an untrusted value as a v4 dashboard doc. Never throws. Returns issues with stable paths.
 * `normalized` is returned whenever the envelope parses (for dry-run preview); persist only when `valid`.
 */
export function validateDocV4(input: unknown): ValidationResult {
  const parsed = docSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((iss) => ({
        path: formatPath(iss.path),
        code: iss.code,
        message: iss.message,
      })),
      warnings: [],
    };
  }

  // Strings were format-validated above; cast to the branded canonical shape for the semantic walk.
  const doc = parsed.data as unknown as DashboardV4;
  const { errors, warnings } = semanticCheck(doc);
  const normalized = normalizeDocV4(doc);
  return { valid: errors.length === 0, errors, warnings, normalized };
}

/**
 * Assign every node a stable `n_…` id (server-assigned when absent). Idempotent: existing ids are
 * preserved, so `normalizeDocV4(normalizeDocV4(x))` deep-equals `normalizeDocV4(x)`. Minted ids skip
 * any id already present, so a partial input can't collide. Deterministic given traversal order.
 */
export function normalizeDocV4(doc: DashboardV4): DashboardV4 {
  const taken = new Set<string>();
  walkNodes(doc, (n) => {
    if (n.id) taken.add(n.id);
  });
  let seq = 0;
  const mint = (): string => {
    let id: string;
    do {
      id = `n_${(seq++).toString(36)}`;
    } while (taken.has(id));
    taken.add(id);
    return id;
  };
  const norm = (node: DashboardNode): DashboardNode => {
    const id = node.id ?? mint();
    return node.kind === "group"
      ? { ...node, id, children: node.children.map(norm) }
      : { ...node, id };
  };
  return { ...doc, root: norm(doc.root) as GroupNode };
}

/**
 * The single §8.3 scope walk: collect every `area`/`device` ref from the fixed envelope positions
 * (never from `config`). Used for share-scope derivation and the authoring no-escalation check —
 * a future/unknown card type can never smuggle a ref the resolver doesn't see.
 */
export function collectRefs(doc: DashboardV4): {
  areas: AreaId[];
  devices: DeviceId[];
} {
  const areas = new Set<AreaId>();
  const devices = new Set<DeviceId>();
  walkNodes(doc, (n) => {
    if (n.area) areas.add(n.area);
    if (n.device) devices.add(n.device);
  });
  return { areas: [...areas], devices: [...devices] };
}
