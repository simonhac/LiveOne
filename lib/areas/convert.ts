/**
 * Composite-metadata → area_bindings converter (P3).
 *
 * Normalises the untyped `systems.metadata` of a `vendor_type='composite'` row into typed
 * {@link AreaBindingDraft} rows — the single representation that replaces every legacy JSON shape:
 *
 *   - v2 `{ version:2, mappings:{ roleId:[ "sys.idx", … ] } }` — point-granular. The ONLY shape
 *     present in prod (Craig #7, Kinkora #8). A role bucket may hold points of MIXED metric_types
 *     and child systems (e.g. Kinkora's `battery` = a soc point from sys 5 + a power point from
 *     sys 6), so `metric_type` is read per-point from point_info, not inferred from the role.
 *   - `{ base_system, overrides:{ role:childSystemId, battery_soc:childSystemId } }` — system-
 *     granular (legacy, the `CompositeAdapter.getLastReading` shape). Resolved DOWN to points here
 *     via the role registry's anchor stem. No prod row uses it, but supported + tested for safety.
 *   - v1 path-string (`"liveone.system1.source.solar…"`) or anything unrecognised → THROW. None
 *     exist; failing loud is the assertion.
 *
 * Pure (no DB): callers pass the relevant child point_info rows. The round-trip assertions (see
 * __tests__/convert.test.ts) prove, per real composite, that the bindings reproduce today's
 * behaviour before the backfill writes anything.
 */
import { PointReference } from "@/lib/identifiers";
import {
  ROLE_IDS,
  ROLES,
  stemMatchesRole,
  type RoleId,
} from "@/lib/roles/registry";

/** Minimal point_info projection the converter needs. `pointIndex` is point_info.id (per-system). */
export interface ConverterPointInfo {
  systemId: number;
  pointIndex: number;
  logicalPathStem: string | null;
  metricType: string;
  transform: string | null;
}

/** A typed role→point edge, ready to insert into area_bindings (area_id added by the caller). */
export interface AreaBindingDraft {
  role: RoleId;
  metricType: string;
  pointSystemId: number;
  pointId: number;
  /**
   * Deterministic ordering index, assigned in metadata iteration order. NOTE: the KV subscription
   * registry's composite point ref is `${compositeId}.${ordinal}`, but only the `${compositeId}`
   * half is ever consumed (updateLatestPointValue keys the composite's latest hash by logicalPath,
   * not by index) — so ordinal is for ordering/array semantics, not KV identity.
   */
  ordinal: number;
  /** Per-binding transform override; null = inherit point_info.transform. Always null today. */
  transform: string | null;
}

interface V2Metadata {
  version: 2;
  mappings: Record<string, string[]>;
}
interface BaseOverridesMetadata {
  base_system?: number | null;
  overrides?: Record<string, number>;
}

function isV2(m: unknown): m is V2Metadata {
  return (
    !!m &&
    typeof m === "object" &&
    (m as { version?: unknown }).version === 2 &&
    typeof (m as { mappings?: unknown }).mappings === "object" &&
    (m as { mappings?: unknown }).mappings !== null
  );
}

function isBaseOverrides(m: unknown): m is BaseOverridesMetadata {
  if (!m || typeof m !== "object") return false;
  return "base_system" in m || "overrides" in m;
}

function isRoleId(s: string): s is RoleId {
  return (ROLE_IDS as readonly string[]).includes(s);
}

/** Index of child point_info by "sys.idx" and by system, for the two conversion paths. */
class PointIndex {
  private byRef = new Map<string, ConverterPointInfo>();
  private bySystem = new Map<number, ConverterPointInfo[]>();
  constructor(points: ConverterPointInfo[]) {
    for (const p of points) {
      this.byRef.set(`${p.systemId}.${p.pointIndex}`, p);
      const list = this.bySystem.get(p.systemId) ?? [];
      list.push(p);
      this.bySystem.set(p.systemId, list);
    }
  }
  get(systemId: number, pointIndex: number): ConverterPointInfo | undefined {
    return this.byRef.get(`${systemId}.${pointIndex}`);
  }
  /** The exact-anchor-stem point of a system carrying `metricType` (the role's "master"). */
  master(
    systemId: number,
    role: RoleId,
    metricType: string,
  ): ConverterPointInfo | undefined {
    const anchor = ROLES[role].stem;
    return (this.bySystem.get(systemId) ?? []).find(
      (p) =>
        p.metricType === metricType &&
        p.logicalPathStem === anchor &&
        stemMatchesRole(p.logicalPathStem, role),
    );
  }
}

/**
 * Convert one composite's metadata into area_bindings drafts. Throws on an unrecognised shape.
 *
 * @param points the child point_info rows referenced by this composite (a superset is fine).
 */
export function convertCompositeToBindings(
  metadata: unknown,
  points: ConverterPointInfo[],
): AreaBindingDraft[] {
  const index = new PointIndex(points);
  if (isV2(metadata)) return convertV2(metadata, index);
  if (isBaseOverrides(metadata)) return convertBaseOverrides(metadata, index);
  throw new Error(
    `convertCompositeToBindings: unsupported composite metadata shape: ${JSON.stringify(
      metadata,
    )?.slice(0, 200)}`,
  );
}

/**
 * Round-trip safety gate: assert `drafts` reproduce the legacy behaviour of `metadata` BEFORE the
 * backfill writes anything. Throws on any mismatch. Format-specific:
 *   - v2: the binding (system,point) set must equal the set the legacy
 *     `_resolveCompositeSystemPoints` parses from `mappings` (no point gained or lost).
 *   - base_system/overrides: every binding's source system must equal the legacy
 *     `getSourceForMetric` (override ?? base_system) selection for that role/metric.
 */
export function assertCompositeRoundTrip(
  metadata: unknown,
  drafts: AreaBindingDraft[],
): void {
  if (isV2(metadata)) {
    const legacy = new Set<string>();
    for (const refs of Object.values(metadata.mappings)) {
      if (!Array.isArray(refs)) continue;
      for (const refStr of refs) {
        const ref = PointReference.parse(refStr);
        if (ref) legacy.add(`${ref.systemId}.${ref.pointId}`);
      }
    }
    const got = new Set(drafts.map((d) => `${d.pointSystemId}.${d.pointId}`));
    const missing = [...legacy].filter((r) => !got.has(r));
    const extra = [...got].filter((r) => !legacy.has(r));
    if (missing.length || extra.length) {
      throw new Error(
        `assertCompositeRoundTrip(v2): point set mismatch — missing [${missing}], extra [${extra}]`,
      );
    }
    return;
  }
  if (isBaseOverrides(metadata)) {
    const base = metadata.base_system ?? null;
    const overrides = metadata.overrides ?? {};
    const sourceFor = (metric: string): number | null =>
      metric in overrides ? (overrides[metric] ?? null) : base;
    const metricKey = (role: RoleId, metricType: string): string =>
      role === "battery" && metricType === "soc" ? "battery_soc" : role;
    for (const d of drafts) {
      const expected = sourceFor(metricKey(d.role, d.metricType));
      if (d.pointSystemId !== expected) {
        throw new Error(
          `assertCompositeRoundTrip(base/overrides): ${d.role}/${d.metricType} bound to system ` +
            `${d.pointSystemId}, expected ${expected}`,
        );
      }
    }
    return;
  }
  throw new Error("assertCompositeRoundTrip: unsupported metadata shape");
}

/**
 * v2: walk `mappings` in object-key order (matching buildSubscriptionRegistry's enumeration). Each
 * "sys.idx" ref resolves to a point_info row; metric_type is taken from that row.
 */
function convertV2(
  metadata: V2Metadata,
  index: PointIndex,
): AreaBindingDraft[] {
  const drafts: AreaBindingDraft[] = [];
  let ordinal = 0;
  for (const [roleKey, refs] of Object.entries(metadata.mappings)) {
    if (!isRoleId(roleKey)) {
      throw new Error(`convertV2: unknown role key "${roleKey}" in mappings`);
    }
    if (!Array.isArray(refs)) continue;
    for (const refStr of refs) {
      const ref = PointReference.parse(refStr);
      if (!ref) {
        throw new Error(`convertV2: invalid point reference "${refStr}"`);
      }
      const pi = index.get(ref.systemId, ref.pointId);
      if (!pi) {
        throw new Error(
          `convertV2: point ${refStr} (role ${roleKey}) not found in point_info`,
        );
      }
      drafts.push({
        role: roleKey,
        metricType: pi.metricType,
        pointSystemId: ref.systemId,
        pointId: ref.pointId,
        ordinal: ordinal++,
        transform: null,
      });
    }
  }
  return drafts;
}

/**
 * base_system/overrides → points. Mirrors CompositeAdapter.getLastReading's per-metric source
 * selection (override ?? base_system) and resolves each to its child system's MASTER point — the
 * exact-anchor-stem point with the role's metric. battery yields two bindings (power + soc), each
 * from its own source. A metric whose source/point can't be resolved is skipped (the adapter would
 * have yielded null for it) — exactly preserving today's behaviour.
 */
function convertBaseOverrides(
  metadata: BaseOverridesMetadata,
  index: PointIndex,
): AreaBindingDraft[] {
  const base = metadata.base_system ?? null;
  const overrides = metadata.overrides ?? {};
  const sourceFor = (metric: string): number | null =>
    metric in overrides ? (overrides[metric] ?? null) : base;

  const drafts: AreaBindingDraft[] = [];
  let ordinal = 0;
  const add = (role: RoleId, metricType: string, sys: number | null): void => {
    if (sys === null) return;
    const pi = index.master(sys, role, metricType);
    if (!pi) return;
    drafts.push({
      role,
      metricType,
      pointSystemId: sys,
      pointId: pi.pointIndex,
      ordinal: ordinal++,
      transform: null,
    });
  };

  add("solar", "power", sourceFor("solar"));
  add("battery", "power", sourceFor("battery"));
  add("battery", "soc", sourceFor("battery_soc"));
  add("load", "power", sourceFor("load"));
  add("grid", "power", sourceFor("grid"));
  return drafts;
}
