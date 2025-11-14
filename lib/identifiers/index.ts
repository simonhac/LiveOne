/**
 * Identifier types and utilities
 *
 * This module provides type-safe identifiers for the LiveOne system,
 * replacing string-based parsing with structured objects.
 */

export {
  SystemIdentifier,
  PointReference,
  PointPath,
  SeriesPath,
} from "./types";

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
