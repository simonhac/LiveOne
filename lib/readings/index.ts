/**
 * The readings seam public surface — import `ReadingsDao` (+ its boundary types) from here.
 * `schema-internal` (the raw hot-table symbols) is deliberately NOT re-exported: only modules
 * inside `lib/readings/**` may touch it. See dao.ts / schema-internal.ts.
 */
export {
  ReadingsDao,
  type ReadingsExec,
  type ReadWindow,
  type DayRange,
  type SeriesByPoint,
  type RawReading,
  type Agg5mReading,
  type Agg1dReading,
  type RawInsert,
  type Agg5mInsert,
  type Agg1dUpsert,
} from "./dao";
