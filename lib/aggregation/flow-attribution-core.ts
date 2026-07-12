/**
 * Metric attribution is the general FLOW ACCOUNTING core now (lib/aggregation/flow-matrix-core.ts):
 * the Sankey energy matrix is its ENERGY leg, and provenance emissions/renewable/cost are the METRIC
 * legs of the SAME allocation loop — so they can't drift from energy. This module stays as the
 * attribution entry point (`computeFlowAttribution` = `computeFlowAccounting` with intensities supplied).
 */
export { computeFlowAccounting as computeFlowAttribution } from "./flow-matrix-core";
export type {
  SourceIntensity,
  FlowAccountingResult as FlowAttributionResult,
} from "./flow-matrix-core";
