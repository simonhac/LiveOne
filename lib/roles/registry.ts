/**
 * Role registry — the single source of truth for the energy-flow ROLE vocabulary
 * (solar / battery / load / grid / ev) that classifies a point's logical-path stem into the
 * part it plays in an energy site.
 *
 * Before this module the taxonomy was copy-pasted across four places:
 *   - lib/aggregation/logical-system.ts        (isCompleteRoleSet)
 *   - lib/system-summary-store.ts              (aggregateSummaryReadings)
 *   - components/CompositeTab.tsx              (category panels + patterns)
 *   - app/api/admin/systems/[systemId]/composite-config/route.ts  (path validation)
 * They all import from here now, so adding a role (or its HA metadata) is a one-line change.
 *
 * Roles carry Home Assistant export metadata (`device_class` / `state_class` / `unit`) so the
 * planned HA export bridge (docs/architecture/areas-and-dashboards.md) is a publish step, not a
 * remodel. This module is **pure data** — no React, no lucide, no node — so server and client both
 * import it safely.
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
   * System-summary participation. When set, {@link aggregateSummaryReadings} emits
   * `${stem}/${metric}`: for `aggregable` roles it uses the master point or, failing that, the sum
   * of its dotted children; for non-aggregable roles it reads the single point directly. Roles
   * without `summary` (ev) are not summarised.
   */
  summary?: { metric: string; aggregable: boolean };
  /**
   * Run-tracking: marks this role as a first-class binary "running" device (see
   * lib/run-tracking). `haDeviceClass` is the HA `binary_sensor` device_class for the export
   * bridge ("running" — on means running). The role's own `ha` block still describes the
   * underlying numeric signal (e.g. power/W); the binary entity is a derived view over the
   * persisted run periods. Code-only — not projected into the `roles` SQL table.
   */
  device?: { trackable: true; haDeviceClass: string };
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
  ev: {
    id: "ev",
    category: "load",
    stem: "ev",
    label: "EV",
    ha: { deviceClass: "battery", stateClass: "measurement", unit: "%" },
    validatesCompositePath: false,
  },
  // Run-tracking device role (see lib/run-tracking). Deliberately NOT in ROLE_IDS below, so it
  // does not appear in the composite editor's energy-flow panels or get composite-path-validated;
  // it exists as a role so device_trackers.role / device_run_periods.role have an FK target and so
  // the binary "running" entity carries HA export metadata. `ha` describes the numeric signal
  // (power/W); `device.haDeviceClass` is the binary_sensor class.
  generator: {
    id: "generator",
    category: "source",
    stem: "source.generator",
    label: "Generator",
    ha: { deviceClass: "power", stateClass: "measurement", unit: "W" },
    validatesCompositePath: false,
    device: { trackable: true, haDeviceClass: "running" },
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
