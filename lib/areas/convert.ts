/**
 * Composite role→point mapping converter (P3).
 *
 * Converts a composite's v2 `{ version:2, mappings:{ roleId:[ "sys.idx", … ] } }` blob into typed
 * {@link AreaBindingDraft} rows (the authoritative `area_bindings` representation) and back
 * ({@link bindingsToMappings}). A role bucket may hold points of MIXED metric_types and child systems
 * (e.g. Kinkora's `battery` = a soc point from sys 5 + a power point from sys 6), so `metric_type` is
 * read per-point from point_info, not inferred from the role. Anything that isn't the v2 shape throws
 * (the legacy `base_system/overrides` and v1 path-string shapes never reached prod and were retired
 * with composite-as-system).
 *
 * Pure (no DB): callers pass the relevant child point_info rows.
 */
import { PointReference } from "@/lib/identifiers";
import { ROLE_IDS, type RoleId } from "@/lib/roles/registry";

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
   * Deterministic ordering index, assigned in mappings iteration order. NOTE: the KV subscription
   * registry's composite point ref is `${compositeId}.${ordinal}`, but only the `${compositeId}`
   * half is ever consumed (updateLatestPointValue keys the composite's latest hash by logicalPath,
   * not by index) — so ordinal is for ordering/array semantics, not KV identity.
   */
  ordinal: number;
  /** Per-binding transform override; null = inherit point_info.transform. Always null today. */
  transform: string | null;
}

export interface V2Metadata {
  version: 2;
  mappings: Record<string, string[]>;
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

function isRoleId(s: string): s is RoleId {
  return (ROLE_IDS as readonly string[]).includes(s);
}

/** Index of child point_info by "sys.idx". */
class PointIndex {
  private byRef = new Map<string, ConverterPointInfo>();
  constructor(points: ConverterPointInfo[]) {
    for (const p of points) {
      this.byRef.set(`${p.systemId}.${p.pointIndex}`, p);
    }
  }
  get(systemId: number, pointIndex: number): ConverterPointInfo | undefined {
    return this.byRef.get(`${systemId}.${pointIndex}`);
  }
}

/**
 * Convert a composite's v2 mappings blob into area_bindings drafts. Throws on an unrecognised shape.
 *
 * @param points the child point_info rows referenced by this composite (a superset is fine).
 */
export function convertCompositeToBindings(
  metadata: unknown,
  points: ConverterPointInfo[],
): AreaBindingDraft[] {
  const index = new PointIndex(points);
  if (isV2(metadata)) return convertV2(metadata, index);
  throw new Error(
    `convertCompositeToBindings: unsupported composite metadata shape: ${JSON.stringify(
      metadata,
    )?.slice(0, 200)}`,
  );
}

/**
 * Inverse of {@link convertV2}: rebuild the `{version:2, mappings}` blob from a composite's binding
 * refs. Lets the readers (composite-config GET, admin listing) DERIVE the blob from the authoritative
 * `area_bindings`. Sorted by `ordinal` so each role bucket reproduces the original order (ordinals
 * were assigned role-by-role in mappings-key order, so first-occurrence keeps role order too).
 */
export function bindingsToMappings(
  bindings: {
    role: string;
    pointSystemId: number;
    pointId: number;
    ordinal: number;
  }[],
): V2Metadata {
  const ordered = [...bindings].sort((a, b) => a.ordinal - b.ordinal);
  const mappings: Record<string, string[]> = {};
  for (const b of ordered) {
    (mappings[b.role] ??= []).push(`${b.pointSystemId}.${b.pointId}`);
  }
  return { version: 2, mappings };
}

/**
 * Round-trip safety gate: assert `drafts` reproduce the v2 mapping's point set (no point gained or
 * lost). Throws on any mismatch.
 */
export function assertCompositeRoundTrip(
  metadata: unknown,
  drafts: AreaBindingDraft[],
): void {
  if (!isV2(metadata)) {
    throw new Error("assertCompositeRoundTrip: unsupported metadata shape");
  }
  const expected = new Set<string>();
  for (const refs of Object.values(metadata.mappings)) {
    if (!Array.isArray(refs)) continue;
    for (const refStr of refs) {
      const ref = PointReference.parse(refStr);
      if (ref) expected.add(`${ref.systemId}.${ref.pointId}`);
    }
  }
  const got = new Set(drafts.map((d) => `${d.pointSystemId}.${d.pointId}`));
  const missing = [...expected].filter((r) => !got.has(r));
  const extra = [...got].filter((r) => !expected.has(r));
  if (missing.length || extra.length) {
    throw new Error(
      `assertCompositeRoundTrip(v2): point set mismatch — missing [${missing}], extra [${extra}]`,
    );
  }
}

/**
 * v2: walk `mappings` in object-key order. Each "sys.idx" ref resolves to a point_info row;
 * metric_type is taken from that row.
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
