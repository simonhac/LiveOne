# History API Unification Plan

## Overview

Unify the composite and non-composite code paths in `/app/api/history/route.ts` to use `FlavouredPoint[]` from `PointManager.getFilteredSeriesForSystem()`.

## Current State

### Composite Systems (lines 402-947)

- Manually parses `metadata.mappings` to extract point references
- Queries `point_info` table directly
- Builds `pointsWithMetadata` array manually
- Uses individual queries per point (slow)
- Series ID format: `liveone.{siteId}.{capabilityPath}.{metricType}.{aggregation}`

### Non-Composite Systems (lines 949-957)

- Delegates to `HistoryService.getHistoryInOpenNEMFormat()`
- Uses `PointReadingsProvider` internally
- Already uses PointManager for point discovery
- Series ID format: Different (using HistoryService)

## Problems with Current Implementation

1. **Code Duplication**: ~550 lines of nearly identical query logic
2. **Inconsistent Series IDs**: Different formats between composite and non-composite
3. **Composite Systems Don't Use PointManager**: Manually parsing metadata instead of using centralized logic
4. **No Pattern Filtering for Composite**: Composite systems don't support series patterns
5. **Inefficient Queries**: Composite uses N queries instead of batched CTE approach
6. **Debug Info Inconsistent**: Different debug structures between paths

## Target Architecture

### Unified Flow

```
1. Get FlavouredPoint[] from PointManager.getFilteredSeriesForSystem(system, filterPatterns, interval)
   - PointManager handles both composite and non-composite internally
   - PointManager applies pattern filtering via micromatch
   - Returns already-filtered list of points with their flavours

2. Build single CTE query for all points
   - Use VALUES clause with (system_id, point_id) pairs from all FlavouredPoints
   - Query all aggregation fields needed (one per FlavouredPoint)
   - Single batched query for maximum performance

3. Process results and build OpenNEM series
   - Group results by (system_id, point_id, aggregation_field)
   - Apply transforms from point.transform
   - Handle 30m aggregation if needed
   - Build series IDs using new format: {systemIdentifier}/{pointIdentifier}/{flavourIdentifier}

4. Use registerPoint() for debug tracking
   - Automatically captures which pattern matched
```

### Key Data Structures

**FlavouredPoint** (from PointManager):

```typescript
interface FlavouredPoint {
  point: PointInfo; // Contains: systemId, id, type, subtype, extension,
  //           metricType, metricUnit, transform, etc.
  flavour: PointFlavour; // Contains: metricType, aggregationField
  intervals: ("5m" | "1d")[]; // Which intervals support this flavour
}
```

**Query Structure**:

```sql
WITH pairs(system_id, point_id) AS (
  VALUES (1, 5), (1, 7), (2, 3)  -- From FlavouredPoint[].map(fp => [fp.point.systemId, fp.point.id])
)
SELECT
  pra.system_id,
  pra.point_id,
  pra.interval_end,  -- or pra.day for 1d
  pra.avg AS value   -- aggregationField from flavour
FROM point_readings_agg_5m AS pra
JOIN pairs p
  ON p.system_id = pra.system_id
 AND p.point_id = pra.point_id
WHERE pra.interval_end >= ? AND pra.interval_end < ?
ORDER BY pra.system_id, pra.point_id, pra.interval_end
```

**Series ID Format**:

```
{systemIdentifier}/{pointIdentifier}/{flavourIdentifier}

Where:
- systemIdentifier: system.getSiteIdentifier() - e.g., "system.1" or "kinkora_complete"
- pointIdentifier: point.getIdentifier() - e.g., "1.5" (systemId.pointId)
- flavourIdentifier: flavour.getIdentifier() - e.g., "power.avg"

Examples:
- system.1/1.5/power.avg
- kinkora_complete/2.3/energy.delta
```

## Implementation Steps

### Step 1: Update Function Signature

```typescript
async function getSystemHistoryInOpenNEMFormat(
  system: SystemWithPolling,
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: "5m" | "30m" | "1d",
  seriesPatterns?: string[],
  enableDebug?: boolean, // ADD THIS
): Promise<{
  series: OpenNEMDataSeries[];
  debug?: HistoryDebugInfo; // CHANGE TYPE
}>;
```

### Step 2: Add getSiteIdentifier() to SystemWithPolling

```typescript
// In /lib/systems-manager.ts - add method to SystemWithPolling or create helper
export function getSiteIdentifier(system: SystemWithPolling): string {
  return system.shortName || `system.${system.id}`;
}
```

### Step 3: Get Filtered FlavouredPoint[]

```typescript
const pointManager = PointManager.getInstance();

// Note: PointManager only supports "5m" | "1d" intervals, so for "30m" we use "5m"
const intervalForFiltering = interval === "30m" ? "5m" : interval;

const flavouredPoints = await pointManager.getFilteredSeriesForSystem(
  system,
  filterPatterns, // CHANGED: was seriesPatterns
  intervalForFiltering,
);

if (flavouredPoints.length === 0) {
  return { series: [] };
}
```

### Step 4: Build and Execute Single CTE Query

```typescript
const { db } = await import("@/lib/db");
const aggTable =
  interval === "1d" ? "point_readings_agg_1d" : "point_readings_agg_5m";
const startEpoch =
  interval === "1d"
    ? (startTime as CalendarDate).toDate("UTC").getTime()
    : (startTime as ZonedDateTime).toDate().getTime();
const endEpoch =
  interval === "1d"
    ? (endTime as CalendarDate).toDate("UTC").getTime()
    : (endTime as ZonedDateTime).toDate().getTime();

// Initialize debug if enabled
const debug: HistoryDebugInfo | undefined = enableDebug
  ? {
      source: aggTable,
      query: [],
      patterns: seriesPatterns,
      points: [],
    }
  : undefined;

// NOTE: We query ALL aggregation fields for all points in ONE query
// This is more complex but much more efficient than N queries per aggregation field

// Build a map of (system_id, point_id, agg_field) -> FlavouredPoint for lookup
const fpMap = new Map<string, FlavouredPoint>();
for (const fp of flavouredPoints) {
  const key = `${fp.point.systemId}.${fp.point.id}.${fp.flavour.aggregationField}`;
  fpMap.set(key, fp);
}

// Query with UNION ALL for each unique (system_id, point_id, agg_field) tuple
// OR: Use dynamic column selection if all points use same aggregation fields
// Decision: Use UNION ALL approach for flexibility with mixed aggregation fields
```

### Step 5: Process Results and Build Series

```typescript
// Group rows by (system_id, point_id)
const rowsByPoint = new Map<
  string,
  Array<{ interval_end: number; value: number | null }>
>();
for (const row of allRows) {
  const key = `${row.system_id}.${row.point_id}`;
  if (!rowsByPoint.has(key)) {
    rowsByPoint.set(key, []);
  }
  rowsByPoint.get(key)!.push({
    interval_end: row.interval_end,
    value: row.value,
  });
}

const allSeries: OpenNEMDataSeries[] = [];

for (const fp of flavouredPoints) {
  const key = `${fp.point.systemId}.${fp.point.id}`;
  let rows = rowsByPoint.get(key) || [];

  // Apply transform
  rows = rows.map((row) => ({
    interval_end: row.interval_end,
    value: applyTransform(row.value, fp.point.transform),
  }));

  // Handle 30m aggregation if needed
  if (interval === "30m" && aggTable === "point_readings_agg_5m") {
    rows = aggregateTo30m(rows);
  }

  // Get source system for series ID
  const sourceSystem = await systemsManager.getSystem(fp.point.systemId);
  if (!sourceSystem) continue;

  // Build series ID using new format: {systemIdentifier}/{pointIdentifier}/{flavourIdentifier}
  const systemIdentifier = getSiteIdentifier(sourceSystem);
  const pointIdentifier = fp.point.getIdentifier(); // Returns "systemId.pointId"
  const flavourIdentifier = fp.flavour.getIdentifier(); // Returns "metricType.aggregationField"

  const seriesId = `${systemIdentifier}/${pointIdentifier}/${flavourIdentifier}`;
  // Example: "system.1/1.5/power.avg" or "kinkora_complete/2.3/energy.delta"

  // Build OpenNEM series with gap filling
  const fieldData = buildFieldDataWithGapFilling(
    rows,
    startEpoch,
    endEpoch,
    interval,
  );

  allSeries.push({
    id: seriesId,
    type: "power",
    units: fp.point.metricUnit === "W" ? "MW" : "",
    path: pointPath,
    history: {
      start: formatTime_fromJSDate(
        new Date(startEpoch),
        system.timezoneOffsetMin ?? 600,
      ),
      last: formatTime_fromJSDate(
        new Date(endEpoch - intervalMs),
        system.timezoneOffsetMin ?? 600,
      ),
      interval: interval,
      data: fieldData,
    },
  });

  // Register point for debug tracking
  if (debug) {
    registerPoint(debug, fp);
  }
}

return {
  series: allSeries,
  debug,
};
```

## Benefits

1. **Single Code Path**: ~400 lines instead of ~900
2. **Consistent Series IDs**: Same format for all systems
3. **Pattern Filtering Works Everywhere**: Composite systems now support patterns
4. **Better Performance**: CTE-based batching for all systems
5. **Centralized Point Logic**: All point discovery in PointManager
6. **Better Debug Info**: Consistent HistoryDebugInfo with pattern matching

## Testing Plan

1. **Non-Composite Systems**: Should continue working as before
2. **Composite Systems**: Should work with new pattern filtering support
3. **Series ID Format**: Verify new format matches expected `{id}/{path}/{flavour}`
4. **Debug Output**: Verify debug.points includes pattern matching info
5. **Performance**: Should be faster for composite systems (batched queries)

## Risks & Mitigation

1. **Breaking Change**: Series ID format changes from `liveone.{siteId}.{path}.{metric}.{agg}` to `{systemId}/{pointId}/{flavour}`
   - **Decision**: Use new format, no backward compatibility
   - **Impact**: Frontend will need to handle new format

2. **Composite System Behavior**: Metadata parsing now in PointManager
   - **Mitigation**: Already tested in PointManager implementation
   - **Fallback**: Can use git stash to restore old code if needed

3. **Complex Refactoring**: Large function rewrite
   - **Mitigation**: Keep old code in git history
   - **Approach**: Full replacement at once since both paths need to change

## Next Steps

1. Review this plan with user
2. Decide on series ID format (new vs. old)
3. Implement unified function
4. Test with both composite and non-composite systems
5. Clean up old code and SeriesInfo type
