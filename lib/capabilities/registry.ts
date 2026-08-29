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
 *    literals in the retired lib/dashboard/cards.ts (`availableTiles`/`chartHasData`, deleted at Phase 14
 *    stage 16) and the old
 *    `useTileNodes.available` (now the tile plugins' `isAvailable`, components/dashboard/tiles/).
 *
 * Two tiers of capability:
 *  - **Atomic** — point-derived `(role, metric)`; unions cleanly across members. Derived from either
 *    `point_info` (config, server-side eligibility) or the KV `latest` map (runtime presence). See
 *    lib/capabilities/derive.ts.
 *  - **Compound / derived** — NOT a union; a predicate over area config + external rows. Present as
 *    capability ids here so the catalog can require them, but their satisfaction is a function call
 *    resolved server-side (an enabled run-detector derivation → `generator-running`; area location + a grid point +
 *    NEM region + a seeded OE row → `grid-signals`), not a point-presence scan.
 */

import { stemMatchesRole, type RoleId } from "@/lib/roles/registry";

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
  | "generator/control"
  // Atomic — presence of any numeric signal (the role-free instrumentation fallback):
  | "instrumentation"
  // Compound / derived — satisfaction is a server-side predicate, not a point scan:
  | "generator-running"
  | "ev-charging"
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
  // The hub-supervised generator's WRITABLE run-request point. Atomic and exact: its presence is
  // precisely "this area has a generator that LiveOne can command", which is a different fact from
  // `generator-running` (an enabled run DETECTOR — a genset can be tracked without being
  // controllable, and the Daylesford one was for months). Keep them apart: conflating them would
  // put a Start button on a generator we can only watch.
  "generator/control": {
    id: "generator/control",
    tier: "atomic",
    label: "Generator control",
    match: exact("source.generator.control.request", "duration"),
  },
  // instrumentation is atomic-ish (presence of ANY numeric point) but role-free — derived specially
  // in derive.ts, so it carries no `match` rule.
  instrumentation: {
    id: "instrumentation",
    tier: "atomic",
    label: "Instrumentation",
  },
  // Compound — satisfaction resolved server-side (derivations / grid context).
  "generator-running": {
    id: "generator-running",
    tier: "compound",
    label: "Generator running",
  },
  "ev-charging": {
    id: "ev-charging",
    tier: "compound",
    label: "EV charging",
  },
  "grid-signals": {
    id: "grid-signals",
    tier: "compound",
    label: "Local grid (NEM)",
  },
};

/**
 * Trackable role → the compound capability an enabled run detector for it provides.
 *
 * An explicit map rather than a `${role}-running` template, because the names are not variations on
 * one word: a generator is *running*, an EV is *charging*, and a future pump would be *pumping*.
 * That is the same judgement `ROLES[role].device.haDeviceClass` makes (`running` vs
 * `battery_charging`) — the label has to say what the thing is actually doing, or the Add-Card
 * gallery reads as nonsense.
 *
 * The keys are the roles carrying `device.trackable`; `TRACKABLE_ROLE_IDS` is the source of truth
 * for WHICH roles those are, and this map answers what each one advertises. A trackable role missing
 * from here provides no capability, so its card can never become eligible — hence the total
 * `Record` over `TrackableRoleId` rather than a `Partial`, which makes that a compile error.
 */
export type TrackableRoleId = "generator" | "ev";

export const RUN_TRACKING_CAPABILITY: Record<TrackableRoleId, CapabilityId> = {
  generator: "generator-running",
  ev: "ev-charging",
};

// Compile gate, one direction: every key above is a real role id. The other direction — a role that
// gained `device.trackable` but no capability here — can't be a type error (this module must not
// import a runtime value from the role registry to stay a pure data table), so it is asserted in
// lib/capabilities/__tests__/strategy-equivalence.test.ts instead.
const _trackableRolesAreRoles: readonly RoleId[] = Object.keys(
  RUN_TRACKING_CAPABILITY,
) as TrackableRoleId[];
void _trackableRolesAreRoles;

/** The atomic capability rules, in registry order — the only stem/metric matchers in the codebase. */
export const ATOMIC_CAPABILITY_RULES: ReadonlyArray<
  CapabilityDef & { match: NonNullable<CapabilityDef["match"]> }
> = Object.values(CAPABILITIES).filter(
  (c): c is CapabilityDef & { match: NonNullable<CapabilityDef["match"]> } =>
    c.match != null,
);
