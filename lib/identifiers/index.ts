/**
 * Identifier types and utilities
 *
 * This module provides type-safe identifiers for the LiveOne system,
 * replacing string-based parsing with structured objects.
 */

export { SystemIdentifier, PointReference, SeriesPath } from "./types";

export {
  PointType,
  PointSubtype,
  PointExtension,
  MetricType,
  AggregationField,
  isPointType,
  isMetricType,
  isAggregationField,
} from "./enums";

// Logical path utilities
export {
  isValidLogicalPathStem,
  isValidMetricType,
  isValidLogicalPath,
  getLogicalPathStem,
  getMetricType,
  stemSplit,
  buildLogicalPath,
  matchesLogicalPath,
} from "./logical-path";

// Physical path utilities
export { isValidPhysicalPath, splitPhysicalPath } from "./physical-path";
