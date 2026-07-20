/**
 * Resolve display metadata (label, color, ordering) for the canonical energy-flow paths
 * stored in `point_readings_flow_attr_1d` — NO database access here.
 *
 * The flow table stores only directional canonical paths (`source.battery`, `load.battery`,
 * `source.grid`, `load.grid`, `source.solar*`, `load.<sub>`, `load.rest-of-house`, `load`).
 * Every serving path (`/api/history`'s sub-daily + 1d `include=sankey` branches,
 * `lib/aggregation/flow-attr-read.ts`) turns those into the `EnergyFlowNode { id, label, color }`
 * shape the Sankey expects. Colors come from the same
 * `getColorForPath` the browser path uses — we just normalize the directional battery/grid
 * forms to the underlying device stem (`bidi.battery` / `bidi.grid`) first, since
 * `getColorForPath` keys those by device, not direction. Labels mirror what the client shows
 * (`lib/site-data-processor.ts`): "Battery Charge/Discharge", "Grid Import/Export",
 * "Other" for the synthetic remainder; sub-meters and the master load prefer the point's
 * configured display name.
 */

import { getColorForPath } from "@/lib/chart-colors";
import type {
  DailyFlowMatrices,
  EnergyFlowMatrix,
  EnergyFlowNode,
} from "@/lib/energy-flow-matrix";

/**
 * Normalize a directional flow path to the underlying device stem so color/label lookups that
 * are keyed by device (battery, grid) resolve correctly. Solar and load paths pass through.
 */
export function flowPathToDeviceStem(path: string): string {
  if (path === "source.battery" || path === "load.battery")
    return "bidi.battery";
  if (path === "source.grid" || path === "load.grid") return "bidi.grid";
  return path;
}

/**
 * Color for a canonical flow path — shares `getColorForPath` with the browser path.
 *
 * `getColorForPath` parses a full series path (it splits on `/` then `.`), so a bare stem must
 * carry a metric segment to classify; we append `/power`. The synthetic rest-of-house node is
 * matched exactly by `getColorForPath`, so it is passed through unchanged.
 */
export function colorForFlowPath(path: string): string {
  if (path === "load.rest-of-house") return getColorForPath(path);
  return getColorForPath(`${flowPathToDeviceStem(path)}/power`);
}

/** Human label for a canonical solar path lacking an upstream display name (mirrors the browser). */
function solarLabel(stem: string): string {
  const prefix = "source.solar.";
  const ext = stem.startsWith(prefix) ? stem.slice(prefix.length) : "";
  return ext ? `Solar ${ext.charAt(0).toUpperCase()}${ext.slice(1)}` : "Solar";
}

/** Last path segment, title-cased, as a last-resort label for an unconfigured point. */
function humanizePath(path: string): string {
  const seg = path.split(".").pop() ?? path;
  return seg
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Display label for a canonical flow path. `displayNameByStem` maps a point's
 * `logical_path_stem` to its configured `display_name` (from `point_info`); directional and
 * synthetic nodes use fixed labels that match the client's Sankey.
 */
export function labelForFlowPath(
  path: string,
  displayNameByStem: Map<string, string>,
): string {
  switch (path) {
    case "source.battery":
      return "Battery Discharge";
    case "load.battery":
      return "Battery Charge";
    case "source.grid":
      return "Grid Import";
    case "load.grid":
      return "Grid Export";
    case "load.rest-of-house":
      return "Other"; // mirrors REST_OF_HOUSE_LABEL in site-data-processor
  }
  if (path === "source.solar" || path.startsWith("source.solar.")) {
    return displayNameByStem.get(path) ?? solarLabel(path);
  }
  // Master load ("load") and sub-meters ("load.<sub>") prefer the configured display name.
  return displayNameByStem.get(path) ?? humanizePath(path);
}

/**
 * Canonical ordering ranks so the served matrix tiles like the browser's `buildFlowSeries`
 * order: solar → battery → grid for sources; battery → grid → master → sub-meters →
 * rest-of-house for loads. Ties break alphabetically by path.
 */
function sourceRank(path: string): number {
  if (path === "source.solar") return 0;
  if (path === "source.solar.residual") return 3;
  if (path.startsWith("source.solar.")) return 1;
  if (path === "source.battery") return 10;
  if (path === "source.grid") return 11;
  return 20;
}

function loadRank(path: string): number {
  if (path === "load.battery") return 0;
  if (path === "load.grid") return 1;
  if (path === "load") return 2;
  if (path === "load.rest-of-house") return 9;
  if (path.startsWith("load.")) return 5;
  return 20;
}

export function compareSourcePaths(a: string, b: string): number {
  const ra = sourceRank(a);
  const rb = sourceRank(b);
  return ra !== rb ? ra - rb : a.localeCompare(b);
}

export function compareLoadPaths(a: string, b: string): number {
  const ra = loadRank(a);
  const rb = loadRank(b);
  return ra !== rb ? ra - rb : a.localeCompare(b);
}

/**
 * Assemble the served `EnergyFlowMatrix` from a computed (source-path, load-path, energy) matrix:
 * sort source/load paths canonically, remap the matrix, recompute totals, and resolve each node's
 * `{id, label, color}`. Shared by the on-the-fly history compute and the flow-matrix read endpoint so
 * both present identical node identity/order. `sources`/`loads`/`matrix` are aligned (matrix is
 * `[sourceIdx][loadIdx]`); ordering of the inputs is irrelevant since this re-sorts.
 */
export function toEnergyFlowMatrix(
  sources: string[],
  loads: string[],
  matrix: number[][],
  displayNameByStem: Map<string, string>,
): EnergyFlowMatrix {
  const sOrder = sources
    .map((_, i) => i)
    .sort((a, b) => compareSourcePaths(sources[a], sources[b]));
  const lOrder = loads
    .map((_, i) => i)
    .sort((a, b) => compareLoadPaths(loads[a], loads[b]));

  const sortedSources = sOrder.map((i) => sources[i]);
  const sortedLoads = lOrder.map((i) => loads[i]);
  const m = sOrder.map((si) => lOrder.map((li) => matrix[si][li]));

  const sourceTotals = m.map((row) => row.reduce((sum, v) => sum + v, 0));
  const loadTotals = sortedLoads.map((_, li) =>
    m.reduce((sum, row) => sum + row[li], 0),
  );
  const totalEnergy = sourceTotals.reduce((sum, v) => sum + v, 0);

  const node = (path: string): EnergyFlowNode => ({
    id: path,
    label: labelForFlowPath(path, displayNameByStem),
    color: colorForFlowPath(path),
  });

  return {
    sources: sortedSources.map(node),
    loads: sortedLoads.map(node),
    matrix: m,
    sourceTotals,
    loadTotals,
    totalEnergy,
  };
}

/**
 * Reshape raw `point_readings_flow_attr_1d` rows into per-day energy matrices WITHOUT summing across days
 * (the client sums for the window view or picks a day for the hovered view). The node arrays are the
 * canonical-sorted union of paths across the whole window, so every day's dense matrix shares one
 * index order. Totals are intentionally omitted here — derived by the client per view.
 */
export function toDailyFlowMatrices(
  rows: {
    day: string;
    sourcePath: string;
    loadPath: string;
    energyKwh: unknown;
    // Present only for `source=modern` (point_readings_flow_attr_1d).
    emissionsG?: unknown;
    renewableKwh?: unknown;
    costC?: unknown;
    estimatedKwh?: unknown;
  }[],
  displayNameByStem: Map<string, string>,
  /** Also build the metric legs (emissions/renewable/cost/estimated) from the rows — `source=modern`. */
  includeMetrics = false,
): DailyFlowMatrices {
  const sourcePaths = [...new Set(rows.map((r) => r.sourcePath))].sort(
    compareSourcePaths,
  );
  const loadPaths = [...new Set(rows.map((r) => r.loadPath))].sort(
    compareLoadPaths,
  );
  const sourceIdx = new Map(sourcePaths.map((p, i) => [p, i]));
  const loadIdx = new Map(loadPaths.map((p, i) => [p, i]));

  const S = sourcePaths.length;
  const L = loadPaths.length;
  const numGrid = () => sourcePaths.map(() => new Array<number>(L).fill(0));
  const nullGrid = () =>
    sourcePaths.map(() => new Array<number | null>(L).fill(null));

  interface DayGrids {
    matrix: number[][];
    emissionsG?: (number | null)[][];
    renewableKwh?: (number | null)[][];
    costC?: (number | null)[][];
    estimatedKwh?: number[][];
  }
  const num = (v: unknown): number | null => (v == null ? null : Number(v));

  const byDay = new Map<string, DayGrids>();
  for (const r of rows) {
    let d = byDay.get(r.day);
    if (!d) {
      d = { matrix: numGrid() };
      if (includeMetrics) {
        d.emissionsG = nullGrid();
        d.renewableKwh = nullGrid();
        d.costC = nullGrid();
        d.estimatedKwh = numGrid();
      }
      byDay.set(r.day, d);
    }
    const si = sourceIdx.get(r.sourcePath)!;
    const li = loadIdx.get(r.loadPath)!;
    d.matrix[si][li] = Number(r.energyKwh) || 0;
    if (includeMetrics) {
      d.emissionsG![si][li] = num(r.emissionsG);
      d.renewableKwh![si][li] = num(r.renewableKwh);
      d.costC![si][li] = num(r.costC);
      d.estimatedKwh![si][li] = Number(r.estimatedKwh) || 0;
    }
  }

  const node = (path: string): EnergyFlowNode => ({
    id: path,
    label: labelForFlowPath(path, displayNameByStem),
    color: colorForFlowPath(path),
  });

  // `day` is stored as text and sorts chronologically.
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, g]) => ({ day, ...g }));

  return { sources: sourcePaths.map(node), loads: loadPaths.map(node), days };
}
