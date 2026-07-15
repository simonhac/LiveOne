/**
 * Capability registry — the atomic contract between a DEVICE and the PRESENTATION layer.
 *
 * A **capability** is a `(role, metric)` pair a device (or an area, by union) can offer:
 * `solar/power`, `battery/soc`, `grid/rate`, `load.hws/temperature`, … The presentation layer asks
 * "which cards can this area show?" purely in terms of capabilities — never vendor strings. This is
 * the seed of the capability-driven cleanup (see docs/architecture/areas-and-dashboards.md).
 *
 * Design rules (mirrors lib/roles/registry.ts):
 *  - **Pure data, client+server safe** — no React, no DB, no node. Both sides import it.
 *  - **The atom is `(role, metric)`, not `role`.** Amber needs `grid/rate`; a battery's `power` and
 *    `soc` are separate atoms possibly on different member devices. An area's capability set is the
 *    UNION of its members' `(role, metric)` atoms over the merged point set — NEVER an OR of
 *    per-device role-completeness.
 *  - **This is the ONE place point stems/metrics are string-matched.** It replaces the duplicated
 *    literals in lib/dashboard/cards.ts (`availableTiles`/`chartHasData`) and the old
 *    `useTileNodes.available` (now the tile plugins' `isAvailable`, components/dashboard/tiles/).
 *
 * Two tiers of capability:
 *  - **Atomic** — point-derived `(role, metric)`; unions cleanly across members. Derived from either
 *    `point_info` (config, server-side eligibility) or the KV `latest` map (runtime presence). See
 *    lib/capabilities/derive.ts.
 *  - **Compound / derived** — NOT a union; a predicate over area config + external rows. Present as
 *    capability ids here so the catalog can require them, but their satisfaction is a function call
 *    resolved server-side (device_trackers row → `generator-running`; area location + a grid point +
 *    NEM region + a seeded OE row → `grid-signals`), not a point-presence scan.
 */

import { stemMatchesRole } from "@/lib/roles/registry";

/** A `role/metric` (or compound) capability a device can offer. */
export type CapabilityId =
  // Atomic — point-derived (role, metric):
  | "solar/power"
  | "load/power"
  | "battery/power"
  | "battery/soc"
  | "grid/power"
  | "grid/rate"
  | "ev/soc"
  | "load.hws/temperature"
  | "battery/provenance"
  // Atomic — presence of any numeric signal (the role-free instrumentation fallback):
  | "instrumentation"
  // Compound / derived — satisfaction is a server-side predicate, not a point scan:
  | "generator-running"
  | "grid-signals";

/**
 * Whether a capability is ATOMIC (derivable from a single `(stem, metric)` point) as opposed to
 * COMPOUND (a server-side predicate over area config). Only atomic capabilities have a `match` rule.
 */
export type CapabilityTier = "atomic" | "compound";

export interface CapabilityDef {
  id: CapabilityId;
  tier: CapabilityTier;
  label: string;
  /**
   * ATOMIC only: does a point with this `(logical_path_stem, metric_type)` provide this capability?
   * Reuses `stemMatchesRole` for role-prefixed stems (solar/load — any dotted descendant counts);
   * uses an exact stem for single-canonical-stem roles (battery/grid/ev/hws) so e.g. `grid/power`
   * (`bidi.grid`) is not confused with `grid/rate` (`bidi.grid.import`). Undefined for compound caps.
   */
  match?: (stem: string, metric: string) => boolean;
}

/** `metric === m` AND the stem plays `roleId` (exact stem or a dotted descendant). */
const roleMetric =
  (roleId: Parameters<typeof stemMatchesRole>[1], m: string) =>
  (stem: string, metric: string): boolean =>
    metric === m && stemMatchesRole(stem, roleId);

/** Exact `(stem, metric)` — for single-canonical-stem capabilities. */
const exact =
  (s: string, m: string) =>
  (stem: string, metric: string): boolean =>
    stem === s && metric === m;

/**
 * The capability catalog. Ordered atomic-first. The `match` predicates are written to reproduce the
 * current `availableTiles`/`chartHasData` point-existence checks EXACTLY on the realistic path
 * universe (see lib/capabilities/__tests__/derive-equivalence.test.ts) while being capability-typed
 * rather than string-literal.
 */
export const CAPABILITIES: Record<CapabilityId, CapabilityDef> = {
  // solar/load use role-prefix matching (source.solar[.local/.remote], load[.<sub>]) — general, and
  // identical to the current literals for every stem the 3 live installs actually carry.
  "solar/power": {
    id: "solar/power",
    tier: "atomic",
    label: "Solar power",
    match: roleMetric("solar", "power"),
  },
  "load/power": {
    id: "load/power",
    tier: "atomic",
    label: "Load power",
    match: roleMetric("load", "power"),
  },
  // battery/grid/ev/hws are single canonical stems — exact match, so grid/power (bidi.grid) and
  // grid/rate (bidi.grid.import) stay distinct.
  "battery/power": {
    id: "battery/power",
    tier: "atomic",
    label: "Battery power",
    match: exact("bidi.battery", "power"),
  },
  "battery/soc": {
    id: "battery/soc",
    tier: "atomic",
    label: "Battery charge",
    match: exact("bidi.battery", "soc"),
  },
  "grid/power": {
    id: "grid/power",
    tier: "atomic",
    label: "Grid power",
    match: exact("bidi.grid", "power"),
  },
  "grid/rate": {
    id: "grid/rate",
    tier: "atomic",
    label: "Grid price",
    match: exact("bidi.grid.import", "rate"),
  },
  "ev/soc": {
    id: "ev/soc",
    tier: "atomic",
    label: "EV charge",
    match: exact("ev.battery", "soc"),
  },
  "load.hws/temperature": {
    id: "load.hws/temperature",
    tier: "atomic",
    label: "Hot water",
    match: exact("load.hws", "temperature"),
  },
  // The battery-provenance HELPER device's stored-energy blend point (lib/battery-provenance/
  // register.ts) — its presence means the area has a computed provenance history to show.
  "battery/provenance": {
    id: "battery/provenance",
    tier: "atomic",
    label: "Battery provenance",
    match: exact("bidi.battery", "stored-energy"),
  },
  // instrumentation is atomic-ish (presence of ANY numeric point) but role-free — derived specially
  // in derive.ts, so it carries no `match` rule.
  instrumentation: {
    id: "instrumentation",
    tier: "atomic",
    label: "Instrumentation",
  },
  // Compound — satisfaction resolved server-side (device_trackers / grid context).
  "generator-running": {
    id: "generator-running",
    tier: "compound",
    label: "Generator running",
  },
  "grid-signals": {
    id: "grid-signals",
    tier: "compound",
    label: "Local grid (NEM)",
  },
};

/** The atomic capability rules, in registry order — the only stem/metric matchers in the codebase. */
export const ATOMIC_CAPABILITY_RULES: ReadonlyArray<
  CapabilityDef & { match: NonNullable<CapabilityDef["match"]> }
> = Object.values(CAPABILITIES).filter(
  (c): c is CapabilityDef & { match: NonNullable<CapabilityDef["match"]> } =>
    c.match != null,
);
