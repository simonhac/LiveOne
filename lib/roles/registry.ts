/**
 * Role registry — the single source of truth for the energy-flow ROLE vocabulary
 * (solar / battery / load / grid / ev) that classifies a point's logical-path stem into the
 * part it plays in an energy site.
 *
 * Before this module the taxonomy was copy-pasted across four places:
 *   - lib/aggregation/logical-system.ts        (isCompleteRoleSet)
 *   - lib/device-summary-store.ts              (aggregateSummaryReadings)
 *   - components/CompositeTab.tsx              (category panels + patterns)
 *   - app/api/admin/devices/[systemId]/composite-config/route.ts  (path validation)
 * They all import from here now, so adding a role (or its HA metadata) is a one-line change.
 *
 * Roles carry Home Assistant export metadata (`device_class` / `state_class` / `unit`) so the
 * planned HA export bridge (docs/architecture/areas-and-dashboards.md) is a publish step, not a
 * remodel. This module is **pure data** — no React, no lucide, no node — so server and client both
 * import it safely.
 *
 * ── The stems are a HIERARCHY, and that is a modelling rule, not a naming style ──────────────────
 * `load` and `source.solar` work the same way: the anchor stem is the site TOTAL, and each dotted
 * child (`load.ev`, `source.solar.local`) is a METERED SUBSET of it. An anchor is therefore a flow
 * node in its own right only when it has NO children; once it has children it becomes a BUDGET, and
 * the nodes are the children plus ONE complement absorbing the remainder (`load.rest-of-house`,
 * `source.solar.residual`) — synthesised, or measured where a vendor publishes that quantity. Emit
 * both an anchor and its children and you double-count the subsets against the total.
 *
 * The corollary is that a role's stem is not automatically a node: `ev` is a real role with real
 * points, but `ev.charge` is a vehicle's own view of energy already metered by a `load.ev` circuit
 * or the site meter, so it never becomes a sink. That is what the two "deliberately absent" comments
 * in `classifyEnergyStem` and `isCompleteRoleSet` below are consequences of. `buildFlowSeries`
 * (lib/aggregation/flow-series.ts) is where the rule is implemented; the Directional model section
 * of docs/architecture/energy-flow-matrix.md is the prose version.
 *
 * ⚠️ There is no SQL copy of this any more. The `roles` table (a projection of `ROLES`) was dropped
 * by migration 0044; the only thing SQL still knows about the role set is the enumeration in the
 * `area_bindings_role_check` / `derivations_role_check` CHECK constraints. ADDING A ROLE HERE
 * therefore needs a migration that widens both CHECKs — nothing derives them from this file.
 */

export type RoleId = "solar" | "battery" | "load" | "grid" | "ev" | "generator";

/** Energy-flow side. `bidi` roles (battery, grid) split into a source half and a load half. */
export type RoleCategory = "source" | "load" | "bidi";

export interface RoleDef {
  id: RoleId;
  category: RoleCategory;
  /**
   * Anchor logical-path stem. A point plays this role when its stem equals the anchor or is a
   * dotted descendant of it (see {@link stemMatchesRole}). e.g. solar → "source.solar" matches
   * "source.solar" and "source.solar.local".
   */
  stem: string;
  /** Default UI label. */
  label: string;
  /** Home Assistant entity metadata for the export bridge. */
  ha: {
    deviceClass: string;
    stateClass: "measurement" | "total" | "total_increasing";
    unit: string;
  };
  /**
   * Whether the composite-config endpoint validates that a point mapped to this category has a
   * compatible stem. Mirrors the historical behaviour exactly: solar/battery/load/grid were
   * validated; `ev` was allowed through unchecked. Keep this exact so existing ev mappings aren't
   * newly rejected on save.
   */
  validatesCompositePath: boolean;
  /**
   * Device-summary participation. When set, {@link aggregateSummaryReadings} emits
   * `${stem}/${metric}`: for `aggregable` roles it uses the master point or, failing that, the sum
   * of its dotted children; for non-aggregable roles it reads the single point directly. Roles
   * without `summary` (ev) are not summarised.
   */
  summary?: { metric: string; aggregable: boolean };
  /**
   * Run-tracking: marks this role as a first-class binary "is it on" device (see lib/run-tracking).
   * `haDeviceClass` is the HA `binary_sensor` device_class for the export bridge, and it is per-role
   * because the question differs — `running` for a generator, `battery_charging` for an EV. The
   * role's own `ha` block still describes the underlying numeric signal; the binary entity is a
   * derived view over the persisted run periods.
   *
   * A trackable role is NOT necessarily outside `ROLE_IDS`: `generator` exists only to be tracked,
   * but `ev` is an energy-flow role that is also trackable.
   *
   * `chartFlowPath` is the flow-matrix node whose stacked band this role's run periods are drawn
   * over (`SeriesData.flowPath`, set by `flowPathForSeries`). Spelled out per role rather than
   * derived from `category` + `stem`, because the two roles disagree about what `stem` already
   * contains: `ev` is `{load, ev}` → `load.ev`, but `generator` is `{source, source.generator}` →
   * `source.generator`. Any concatenation rule gets exactly one of them wrong, silently, and the
   * symptom is a chart with no overlay rather than an error. Same hand-kept-enum reasoning as
   * `runsConfigSchema`. Absent = this role has no band to draw on.
   */
  device?: {
    trackable: true;
    haDeviceClass: string;
    chartFlowPath?: string;
  };
}

/** Canonical role order — drives the composite editor's panel order. */
export const ROLE_IDS: readonly RoleId[] = [
  "solar",
  "battery",
  "load",
  "grid",
  "ev",
];

export const ROLES: Record<RoleId, RoleDef> = {
  solar: {
    id: "solar",
    category: "source",
    stem: "source.solar",
    label: "Solar",
    ha: { deviceClass: "power", stateClass: "measurement", unit: "W" },
    validatesCompositePath: true,
    summary: { metric: "power", aggregable: true },
  },
  battery: {
    id: "battery",
    category: "bidi",
    stem: "bidi.battery",
    label: "Battery",
    ha: { deviceClass: "battery", stateClass: "measurement", unit: "%" },
    validatesCompositePath: true,
    summary: { metric: "soc", aggregable: false },
  },
  load: {
    id: "load",
    category: "load",
    stem: "load",
    label: "Load",
    ha: { deviceClass: "power", stateClass: "measurement", unit: "W" },
    validatesCompositePath: true,
    summary: { metric: "power", aggregable: true },
  },
  grid: {
    id: "grid",
    category: "bidi",
    stem: "bidi.grid",
    label: "Grid",
    ha: { deviceClass: "power", stateClass: "measurement", unit: "W" },
    validatesCompositePath: true,
    summary: { metric: "power", aggregable: false },
  },
  // Trackable (see lib/run-tracking): a charge session is a run period, detected off whichever
  // point the detector's `source_points.signal` names — at Kinkora that is the Mondo EV circuit's
  // `load.ev/power`, not a vehicle-reported series. `ha` still describes the role's numeric signal
  // (SoC/%, which is what the `ev` tile reads); `device.haDeviceClass` is the binary entity's class,
  // and HA spells "is it charging" `battery_charging` rather than `running`.
  //
  // Unlike `generator`, this role IS in ROLE_IDS — it is a real energy-flow role that also happens to
  // be trackable. `lib/roles/__tests__/registry.test.ts` only constrains the converse (every role
  // OUTSIDE ROLE_IDS must be trackable), so the two facts coexist.
  ev: {
    id: "ev",
    category: "load",
    stem: "ev",
    label: "EV",
    ha: { deviceClass: "battery", stateClass: "measurement", unit: "%" },
    validatesCompositePath: false,
    device: {
      trackable: true,
      haDeviceClass: "battery_charging",
      chartFlowPath: "load.ev",
    },
  },
  // Run-tracking device role (see lib/run-tracking). Deliberately NOT in ROLE_IDS below, so it
  // does not appear in the composite editor's energy-flow panels or get composite-path-validated;
  // it exists so a run-detector `derivations.role` has a legal value (the CHECK covers the same six
  // roles) and so the binary "running" entity carries HA export metadata. `ha` describes the numeric
  // signal (power/W); `device.haDeviceClass` is the binary_sensor class.
  generator: {
    id: "generator",
    category: "source",
    stem: "source.generator",
    label: "Generator",
    ha: { deviceClass: "power", stateClass: "measurement", unit: "W" },
    validatesCompositePath: false,
    device: {
      trackable: true,
      haDeviceClass: "running",
      chartFlowPath: "source.generator",
    },
  },
};

/**
 * Whether `stem` plays `roleId` — exact match on the role's anchor stem, or a dotted descendant.
 * Reproduces the two historical composite matchers (CompositeTab.matchesPattern and the
 * composite-config route's matchesPattern), which agreed on this prefix semantics.
 */
export function stemMatchesRole(stem: string, roleId: RoleId): boolean {
  const anchor = ROLES[roleId].stem;
  return stem === anchor || stem.startsWith(anchor + ".");
}

/** Role ids whose composite mappings are path-validated by the composite-config endpoint. */
export const COMPOSITE_VALIDATED_ROLE_IDS: readonly RoleId[] = ROLE_IDS.filter(
  (id) => ROLES[id].validatesCompositePath,
);

/**
 * The roles a run detector can be configured for — derived from `device.trackable`, so adding a
 * trackable role is a one-line change here and nowhere else. Iterated over `ROLES` (not `ROLE_IDS`),
 * because `generator` is deliberately absent from the latter.
 *
 * Read by the capability resolver (lib/capabilities/server.ts) to decide which `derivations` roles to
 * probe for, and by the seed writer to validate `--role`.
 */
export const TRACKABLE_ROLE_IDS: readonly RoleId[] = (
  Object.keys(ROLES) as RoleId[]
).filter((id) => ROLES[id].device?.trackable);

/**
 * How an ENERGY-accumulator point (metric_type "energy", per-interval Wh in `agg_5m.delta`)
 * participates in the energy-flow matrix. The flow pipeline prefers these exact interval energies
 * over integrating average power (see `FlowSeries.energyKwh` in flow-matrix-core.ts); this
 * classifier is the single vendor-free mapping from an energy point's logical-path stem to the
 * flow node(s) it decorates.
 *
 *  - `pair`: one directional half of a bidi channel, metered separately (Sigenergy / Selectronic /
 *    Fusher / Amber). Both halves of an interval can be nonzero at once — this is what preserves
 *    GROSS flow where the signed power average nets an intra-interval reversal to ~0.
 *  - `net`: a SIGNED net accumulator carrying the bidi channel's own stem — split by sign like the
 *    power series (exact net; gross-lossy, the meter already destroyed the reversal). ⚠️ A
 *    direction-blind MONOTONIC total (e.g. Mondo's `totalEnergyWh`) must NOT be typed with a bidi
 *    stem — its non-negative deltas would all land on the source half. (Mondo's are untyped today.)
 *  - `uni`: a one-direction channel whose energy stem IS the flow node path (solar, load, EV).
 */
export type EnergyStemClass =
  | { kind: "pair"; targetPath: string }
  | { kind: "net"; channelStem: "bidi.battery" | "bidi.grid" }
  | { kind: "uni"; targetPath: string };

/** Directional-pair energy stems → the flow node they meter. `.controlled` (Amber controlled load)
 *  is grid consumption metered on a separate register — summed into the import-side node. */
const ENERGY_PAIR_TARGETS: Record<string, string> = {
  "bidi.battery.discharge": "source.battery",
  "bidi.battery.charge": "load.battery",
  "bidi.grid.import": "source.grid",
  "bidi.grid.export": "load.grid",
  "bidi.grid.controlled": "source.grid",
};

/** Classify an energy point's stem for flow participation; null = not a flow energy stem. */
export function classifyEnergyStem(stem: string): EnergyStemClass | null {
  const pair = ENERGY_PAIR_TARGETS[stem];
  if (pair !== undefined) return { kind: "pair", targetPath: pair };
  // 🛑 `net` REQUIRES A SIGNED REGISTER — one whose delta can be negative — because the overlay
  // splits that delta by sign onto the channel's two halves (attachEnergyOverlays). A cumulative
  // ONE-WAY total (`transform='d'` over a monotonic counter, e.g. Mondo's `totalEnergyWh`) never
  // goes backwards, so every delta is positive and the circuit's whole throughput lands on a single
  // direction — 174 kWh of "battery discharge" against zero charge, measured on Kinkora. Nothing
  // here can tell the two apart from the stem alone, so the gate is at the point where a stem gets
  // ASSIGNED: `scripts/utils/restem-circuit.ts` refuses a bare `bidi.*` on a counter with no
  // observed negative deltas, and `scripts/utils/check-circuit-stems.ts` reports it fleet-wide. A
  // bidirectional circuit wants a charge/discharge PAIR of registers, not a net total.
  if (stem === "bidi.battery" || stem === "bidi.grid")
    return { kind: "net", channelStem: stem };
  if (
    stem === "source.solar" ||
    stem.startsWith("source.solar.") ||
    stem === "load" ||
    stem.startsWith("load.")
  )
    return { kind: "uni", targetPath: stem };
  // `ev.charge` is deliberately absent: an EV charger participates as `load.ev` (a child of the load
  // hierarchy). An `ev.charge`-stemmed register is the vehicle's own view of energy already metered
  // elsewhere, so it decorates no node — see `buildFlowSeries`.
  return null;
}

/**
 * Whether a set of logical-path stems forms a complete energy-flow role set (≥1 source and ≥1
 * load). Moved verbatim from logical-system.ts.
 *
 * Note the deliberate asymmetry preserved from the original: `bidi.battery` / `bidi.grid` match
 * EXACTLY (they are single canonical stems), while solar/load match by prefix. Battery and grid
 * count as both a source and a load (they split into halves).
 */
export function isCompleteRoleSet(stems: string[]): boolean {
  const isSolar = (s: string) =>
    s === "source.solar" || s.startsWith("source.solar.");
  let hasSource = false;
  let hasLoad = false;
  for (const s of stems) {
    if (isSolar(s) || s === "bidi.battery" || s === "bidi.grid")
      hasSource = true;
    // `ev.charge` is NOT counted: it is not a flow sink (an EV charger participates as `load.ev`),
    // so an area whose only "load" was an EV point would be judged complete and then render an
    // empty sink side.
    if (
      s === "load" ||
      s.startsWith("load.") ||
      s === "bidi.battery" ||
      s === "bidi.grid"
    )
      hasLoad = true;
  }
  return hasSource && hasLoad;
}
