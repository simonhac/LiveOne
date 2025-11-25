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

// Point path utilities - simple string-based functions replacing PointPath class
export type { ParsedPointPath } from "./point-path-utils";
export {
  buildPointPath,
  buildFallbackPointPath,
  parsePointPath,
  buildPointIdentifier,
  getIdentifierFromParsed,
  getPointIdentifier,
  getMetricType,
  matchesPointPath,
} from "./point-path-utils";
