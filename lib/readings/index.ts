/**
 * The readings seam public surface — import `ReadingsDao` (+ its boundary types) from here.
 * `schema-internal` (the raw hot-table symbols) is deliberately NOT re-exported: only modules
 * inside `lib/readings/**` may touch it. See dao.ts / schema-internal.ts.
 */
export {
  ReadingsDao,
  type SeriesByPoint,
  type RawReading,
  type Agg5mReading,
  type Agg30mReading,
  type Agg1dReading,
  type RawInsert,
  type Agg5mInsert,
  type Agg1dUpsert,
  type ActivePointLatest,
} from "./dao";
