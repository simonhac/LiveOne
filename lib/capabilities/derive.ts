/**
 * Capability derivation — the ONE place a capability set is computed. Collapses the three duplicated
 * point-path derivers (`availableTiles`/`chartHasData` in lib/dashboard/cards.ts and
 * `useTileNodes.available`) into a single rule pass over the capability registry.
 *
 * Two entry points for the SAME rule table — the distinction is the backbone of the design:
 *  - `capabilitiesFromPoints(points)` — SERVER, from `point_info` (CONFIG). Answers "which cards CAN
 *    this device/area show", so an area advertises before it has ever received data → the
 *    "accept devices never seen before" property.
 *  - `capabilitiesFromLatest(latest)` — CLIENT, from the KV `latest` map (runtime PRESENCE). Answers
 *    "does this tile have a value right now" (skeleton vs empty).
 *
 * Both are ATOMIC-only. Compound capabilities (`generator-running`, `grid-signals`) are added by the
 * server-side `deviceCapabilities`/`areaCapabilities` resolvers (a predicate over device_trackers /
 * grid context), never a point scan — see lib/capabilities (server module, added later).
 */

import type { LatestPointValues } from "@/lib/types/api";
import {
  ATOMIC_CAPABILITY_RULES,
  type CapabilityId,
} from "@/lib/capabilities/registry";

export type CapabilitySet = ReadonlySet<CapabilityId>;

/** A point's semantic classification, as stored on `point_info`. */
export interface PointClass {
  logicalPathStem: string | null;
  metricType: string;
}

/** Split a logical path (`stem/metric`, e.g. `source.solar.local/power`) at its LAST `/`. */
function splitLogicalPath(
  path: string,
): { stem: string; metric: string } | null {
  const i = path.lastIndexOf("/");
  if (i <= 0 || i === path.length - 1) return null;
  return { stem: path.slice(0, i), metric: path.slice(i + 1) };
}

/** Run the atomic capability rules over one `(stem, metric)`, adding every match to `out`. */
function collectAtomic(
  stem: string,
  metric: string,
  out: Set<CapabilityId>,
): void {
  for (const rule of ATOMIC_CAPABILITY_RULES) {
    if (rule.match(stem, metric)) out.add(rule.id);
  }
}

/**
 * Capabilities a device/area offers given its CONFIGURED points (`point_info`). Config-sourced, so it
 * is defined even before any reading has arrived. Points with a null `logicalPathStem` contribute
 * only `instrumentation`.
 */
export function capabilitiesFromPoints(
  points: PointClass[],
): Set<CapabilityId> {
  const caps = new Set<CapabilityId>();
  let anyPoint = false;
  for (const p of points) {
    anyPoint = true;
    if (p.logicalPathStem) collectAtomic(p.logicalPathStem, p.metricType, caps);
  }
  if (anyPoint) caps.add("instrumentation");
  return caps;
}

/**
 * Capabilities present in the runtime `latest` map (a value is currently reported). Key format is the
 * logical path `stem/metric` (lib/types/api.ts). Only entries whose `value` is non-null count, matching
 * the `hasVal` guard in the current derivers.
 */
export function capabilitiesFromLatest(
  latest: LatestPointValues,
): Set<CapabilityId> {
  const caps = new Set<CapabilityId>();
  let anyNumeric = false;
  for (const [path, v] of Object.entries(latest)) {
    if (v?.value == null) continue;
    if (typeof v.value === "number") anyNumeric = true;
    const parts = splitLogicalPath(path);
    if (parts) collectAtomic(parts.stem, parts.metric, caps);
  }
  if (anyNumeric) caps.add("instrumentation");
  return caps;
}

/** Union of capability sets (an area over its members). Compound caps are merged in by the resolver. */
export function unionCapabilities(
  sets: Iterable<CapabilitySet>,
): Set<CapabilityId> {
  const out = new Set<CapabilityId>();
  for (const s of sets) for (const c of s) out.add(c);
  return out;
}

/**
 * Whether a set of logical paths warrants the AGGREGATE (stacked-area site) chart layout rather than a
 * single lines chart — the vendor-free replacement for `getLayout(vendorType) === "site"`.
 *
 * The signal is a **sub-LOAD breakdown** (`load.<sub>/power`, e.g. `load.hvac`, `load.pool`): a
 * whole-home meter (mondo) or a multi-device area carries these, so the stacked load/generation split
 * is meaningful. A single inverter (selectronic/sigenergy) reports only the master `load/power` — and
 * note it may still report sub-SOURCES like `source.solar.local`, which are NOT a stacking signal
 * (verified: selectronic is sidebar despite carrying `source.solar.local`). Hot water (`load.hws`) is
 * excluded — a derived helper load, not a site sub-load.
 */
const SUB_LOAD_BREAKDOWN = /^load\.([^/]+)\/power$/;
function pathsAggregate(paths: Iterable<string>): boolean {
  for (const p of paths) {
    const m = SUB_LOAD_BREAKDOWN.exec(p);
    if (m && m[1] !== "hws") return true;
  }
  return false;
}

/** Aggregate-layout check from the runtime `latest` map (client / device viewer). */
export function isAggregateFromLatest(latest: LatestPointValues): boolean {
  return pathsAggregate(Object.keys(latest));
}

/** Aggregate-layout check from configured points (server / area over its member union). */
export function isAggregateFromPoints(points: PointClass[]): boolean {
  return pathsAggregate(
    points
      .map((p) =>
        p.logicalPathStem ? `${p.logicalPathStem}/${p.metricType}` : "",
      )
      .filter(Boolean),
  );
}
