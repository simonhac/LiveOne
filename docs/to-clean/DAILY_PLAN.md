# Daily Aggregation Implementation Plan

**Status**: Planning
**Created**: 2025-11-08
**Purpose**: Document the implementation plan for `point_readings_agg_1d` table and daily aggregation for point-based systems

---

## Table of Contents

1. [Current System Overview](#current-system-overview)
2. [Points vs Readings Systems](#points-vs-readings-systems)
3. [Implementation Plan](#implementation-plan)
4. [Testing Strategy](#testing-strategy)
5. [Production Deployment](#production-deployment)
6. [Open Questions](#open-questions)

---

## Current System Overview

### Existing Daily Aggregation (Composite Systems)

**For Selectronic systems** using the `readings` table:

- **Raw Data**: `readings` table (minutely polling)
- **5-Min Aggregation**: `readings_agg_5m` (real-time after insert)
- **Daily Aggregation**: `readings_agg_1d` ✅ **IMPLEMENTED**
  - Runs at 00:05 AEST daily via cron
  - Aggregates previous day's data from `readings_agg_5m`
  - File: [lib/db/aggregate-daily.ts](../lib/db/aggregate-daily.ts)
  - Cron: [app/api/cron/daily/route.ts](../app/api/cron/daily/route.ts)

**Key Features**:

- Timezone-aware day boundaries (00:05 to 00:00 next day)
- Aggregates power (W), energy (kWh), battery SOC (%)
- Energy calculated from cumulative counter deltas
- Tracks data quality (interval_count should be 288)
- Supports historical backfill and catchup

### Current Points Aggregation

**For Mondo/Enphase/Fronius systems** using `point_readings` table:

- **Raw Data**: `point_readings` table (per-point time-series)
- **5-Min Aggregation**: `point_readings_agg_5m` ✅ **IMPLEMENTED**
  - Real-time aggregation after batch insert
  - File: [lib/point-aggregation-helper.ts](../lib/point-aggregation-helper.ts)
  - Efficient: 2 queries (1 SELECT, 1 batch INSERT/UPDATE)
- **Daily Aggregation**: ❌ **NOT IMPLEMENTED**
  - Currently: API aggregates 5-min data in memory (inefficient!)
  - Problem: For 30 days, 20 points = 172,800 rows fetched
  - Solution: Pre-aggregate to `point_readings_agg_1d`

---

## Points vs Readings Systems

### Readings (Composite Systems - Selectronic)

| Feature         | Details                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| **Granularity** | Whole-system composite data                                              |
| **Schema**      | Fixed columns: `solar_w`, `load_w`, `battery_w`, `grid_w`, `battery_soc` |
| **Systems**     | 1 system = 1 row per timestamp                                           |
| **Energy**      | Cumulative totals (calculate delta from previous day)                    |
| **Units**       | Power (W), Energy (kWh), SOC (%)                                         |
| **Aggregation** | ✅ Both 5-min and daily implemented                                      |

### Points (Point-Based Systems - Mondo/Enphase/Fronius)

| Feature         | Details                                                  |
| --------------- | -------------------------------------------------------- |
| **Granularity** | Per-circuit, per-device, per-meter                       |
| **Schema**      | Flexible: each point is separate with `value` column     |
| **Systems**     | 1 system = many points (can be 20-50+ points)            |
| **Energy**      | Either cumulative or interval energy (depends on vendor) |
| **Units**       | Determined by `point_info.metric_unit` (W, Wh, %, etc.)  |
| **Aggregation** | ✅ 5-min implemented, ❌ Daily NOT implemented           |

**Key Difference**: Points are more granular and flexible. One system has many points, each with different metric types.

---

## Implementation Plan

### Phase 1: Database Schema & Core Logic

#### 1.1 Create Migration File

**File**: `migrations/00XX_add_point_readings_agg_1d.sql`

```sql
-- Migration: Add daily aggregation table for point-based systems

BEGIN TRANSACTION;

CREATE TABLE point_readings_agg_1d (
  -- Composite primary key (matches point_readings_agg_5m pattern)
  system_id INTEGER NOT NULL,
  point_id INTEGER NOT NULL,
  day TEXT NOT NULL,  -- YYYY-MM-DD format (system local time)

  -- Aggregated values (generic - units determined by point_info.metric_unit)
  avg REAL,           -- Average value for the day
  min REAL,           -- Minimum value
  max REAL,           -- Maximum value
  first REAL,         -- First value of the day
  last REAL,          -- Last value of the day

  -- For energy points: daily total (calculated from cumulative or summed intervals)
  daily_total REAL,

  -- Data quality metrics
  interval_count INTEGER NOT NULL,  -- Number of 5-min intervals aggregated (should be 288)
  sample_count INTEGER NOT NULL,    -- Total raw samples (cascaded from 5-min aggregates)
  error_count INTEGER NOT NULL,     -- Total errors

  -- Timestamps (in milliseconds - matching point_readings convention)
  created_at INTEGER NOT NULL,      -- Unix epoch milliseconds
  updated_at INTEGER NOT NULL,      -- Unix epoch milliseconds

  PRIMARY KEY (system_id, point_id, day),
  FOREIGN KEY (system_id, point_id) REFERENCES point_info(system_id, id) ON DELETE CASCADE
);

-- Indexes for efficient querying
CREATE INDEX idx_pra1d_system_day ON point_readings_agg_1d(system_id, day);
CREATE INDEX idx_pra1d_day ON point_readings_agg_1d(day);
CREATE INDEX idx_pra1d_updated ON point_readings_agg_1d(updated_at);

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('00XX_add_point_readings_agg_1d');
```

#### 1.2 Update Schema Definition

**File**: `lib/db/schema-monitoring-points.ts`

Add Drizzle schema definition:

```typescript
export const pointReadingsAgg1d = sqliteTable(
  "point_readings_agg_1d",
  {
    systemId: integer("system_id").notNull(),
    pointId: integer("point_id").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD

    avg: real("avg"),
    min: real("min"),
    max: real("max"),
    first: real("first"),
    last: real("last"),
    dailyTotal: real("daily_total"),

    intervalCount: integer("interval_count").notNull(),
    sampleCount: integer("sample_count").notNull(),
    errorCount: integer("error_count").notNull(),

    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.systemId, table.pointId, table.day] }),
    systemDayIdx: index("idx_pra1d_system_day").on(table.systemId, table.day),
    dayIdx: index("idx_pra1d_day").on(table.day),
    updatedIdx: index("idx_pra1d_updated").on(table.updatedAt),
  }),
);
```

#### 1.3 Create Aggregation Logic

**File**: `lib/point-aggregate-daily.ts` (NEW)

This file will mirror the structure of [lib/db/aggregate-daily.ts](../lib/db/aggregate-daily.ts) but adapted for points.

**Core Functions**:

```typescript
/**
 * Aggregate daily data for a single point on a specific day
 * @param systemId - System ID
 * @param pointId - Point ID
 * @param day - Day string in YYYY-MM-DD format (system local time)
 */
export async function aggregatePointDailyData(
  systemId: number,
  pointId: number,
  day: string,
): Promise<void>;

/**
 * Aggregate all daily data for a point across a date range
 * Skips days that already exist in point_readings_agg_1d
 * @param systemId - System ID
 * @param pointId - Point ID
 * @param startDate - Start date (defaults to earliest data)
 * @param endDate - End date (defaults to yesterday)
 */
export async function aggregateAllPointDailyData(
  systemId: number,
  pointId: number,
  startDate?: string,
  endDate?: string,
): Promise<number>;

/**
 * Aggregate yesterday's data for all points in all systems
 * Called by daily cron job at 00:05 AEST
 */
export async function aggregateYesterdayPointsForAllSystems(): Promise<void>;

/**
 * Find all missing days across all point systems and aggregate them
 * Used for historical backfill
 */
export async function aggregateAllMissingDaysForAllPointSystems(): Promise<void>;

/**
 * Clear and regenerate all daily aggregates for all point systems
 * WARNING: Deletes all existing data!
 */
export async function regenerateAllPointDailyAggregates(): Promise<void>;
```

**Key Logic Details**:

1. **Day Boundary Calculation**:

   ```typescript
   // Get system timezone offset
   const system = await db.query.systems.findFirst({
     where: eq(systems.id, systemId)
   });
   const tzOffsetMin = system?.timezoneOffsetMin ?? 0;

   // Calculate day boundaries in Unix milliseconds
   // Day: 00:05 to 00:00 next day (inclusive) = 288 intervals
   const dayStart = /* calculate with timezone */;
   const dayEnd = /* calculate with timezone */;
   ```

2. **Query 5-Min Aggregates**:

   ```typescript
   const intervals = await db
     .select()
     .from(pointReadingsAgg5m)
     .where(
       and(
         eq(pointReadingsAgg5m.systemId, systemId),
         eq(pointReadingsAgg5m.pointId, pointId),
         gte(pointReadingsAgg5m.intervalEnd, dayStart),
         lte(pointReadingsAgg5m.intervalEnd, dayEnd),
       ),
     )
     .orderBy(pointReadingsAgg5m.intervalEnd);
   ```

3. **Calculate Aggregates**:

   ```typescript
   const validValues = intervals
     .map((i) => i.avg)
     .filter((v) => v !== null) as number[];

   const avg =
     validValues.length > 0
       ? validValues.reduce((a, b) => a + b) / validValues.length
       : null;

   const min = validValues.length > 0 ? Math.min(...validValues) : null;

   const max = validValues.length > 0 ? Math.max(...validValues) : null;

   const first = intervals.find((i) => i.avg !== null)?.avg ?? null;
   const last = intervals.reverse().find((i) => i.avg !== null)?.avg ?? null;

   // For energy points: calculate daily_total
   const dailyTotal = calculateDailyTotal(pointInfo, intervals);
   ```

4. **Energy Calculation** (needs decision - see Open Questions):

   ```typescript
   function calculateDailyTotal(
     pointInfo: PointInfo,
     intervals: PointAgg5m[],
   ): number | null {
     // Option A: Cumulative difference (like Selectronic)
     // const first = intervals[0]?.last;
     // const last = intervals[intervals.length - 1]?.last;
     // return last && first ? last - first : null;

     // Option B: Sum of interval energy (like Enphase)
     // const sum = intervals
     //   .map(i => i.dailyTotal)
     //   .filter(v => v !== null)
     //   .reduce((a, b) => a + b, 0);
     // return sum;

     // Option C: Detect based on metric type
     if (pointInfo.metricType === "energy") {
       // Implement appropriate logic
     }
     return null;
   }
   ```

5. **Upsert with Conflict Resolution**:
   ```typescript
   await db
     .insert(pointReadingsAgg1d)
     .values({
       systemId,
       pointId,
       day,
       avg,
       min,
       max,
       first,
       last,
       dailyTotal,
       intervalCount: intervals.length,
       sampleCount: intervals.reduce((sum, i) => sum + i.sampleCount, 0),
       errorCount: intervals.reduce((sum, i) => sum + i.errorCount, 0),
       createdAt: Date.now(),
       updatedAt: Date.now(),
     })
     .onConflictDoUpdate({
       target: [
         pointReadingsAgg1d.systemId,
         pointReadingsAgg1d.pointId,
         pointReadingsAgg1d.day,
       ],
       set: {
         /* update fields */
       },
     });
   ```

---

### Phase 2: Cron Integration

#### 2.1 Update Daily Cron Job

**File**: `app/api/cron/daily/route.ts`

**Changes Required**:

1. **Import new functions**:

   ```typescript
   import {
     aggregateYesterdayPointsForAllSystems,
     regenerateAllPointDailyAggregates,
   } from "@/lib/point-aggregate-daily";
   ```

2. **Update GET handler** (automatic 00:05 run):

   ```typescript
   export async function GET(request: NextRequest) {
     // ... existing auth ...

     console.log("[Cron] Running daily aggregation for composite systems");
     await aggregateYesterdayForAllSystems();

     console.log("[Cron] Running daily aggregation for point-based systems");
     await aggregateYesterdayPointsForAllSystems();

     return NextResponse.json({
       success: true,
       message: "Daily aggregation completed for all systems",
     });
   }
   ```

3. **Update POST handler** (manual actions):

   ```typescript
   export async function POST(request: NextRequest) {
     const { action } = await request.json();

     switch (action) {
       case "regenerate":
         // Regenerate BOTH composite and point systems
         await regenerateAllDailyAggregates(); // existing
         await regenerateAllPointDailyAggregates(); // NEW
         break;

       case "regenerate_points":
         // Only regenerate point systems (useful for testing)
         await regenerateAllPointDailyAggregates();
         break;

       case "update":
       default:
         // Update last 7 days for both types
         await aggregateLastNDaysForAllSystems(7); // existing
         await aggregateYesterdayPointsForAllSystems(); // NEW (handles last 7 days internally)
         break;
     }

     return NextResponse.json({ success: true });
   }
   ```

**Cron Schedule** (no changes needed):

- Runs at `5 14 * * *` UTC = 00:05 AEST
- Configured in [vercel.json](../vercel.json)

---

### Phase 3: API Integration

#### 3.1 Update Point Readings Provider

**File**: `lib/history/point-readings-provider.ts`

**Current Implementation** (INEFFICIENT):

```typescript
async fetchDailyData(system, startDate, endDate) {
  // 1. Calls fetch5MinuteData() to get ALL 5-minute intervals
  // 2. Groups by day in memory
  // 3. Aggregates each day in memory
  // Problem: For 30 days × 20 points = 172,800 rows fetched!
}
```

**New Implementation** (EFFICIENT):

```typescript
async fetchDailyData(
  system: System,
  startDate: ZonedDateTime,
  endDate: ZonedDateTime
): Promise<MeasurementSeries[]> {
  // Convert ZonedDateTime to YYYY-MM-DD strings
  const startDateStr = formatDateAsYYYYMMDD(startDate);
  const endDateStr = formatDateAsYYYYMMDD(endDate);

  // Query pre-aggregated daily data
  const dailyData = await db
    .select()
    .from(pointReadingsAgg1d)
    .where(
      and(
        eq(pointReadingsAgg1d.systemId, system.id),
        gte(pointReadingsAgg1d.day, startDateStr),
        lte(pointReadingsAgg1d.day, endDateStr)
      )
    )
    .orderBy(pointReadingsAgg1d.day);

  // Get point info for all points
  const pointIds = [...new Set(dailyData.map(d => d.pointId))];
  const points = await db.query.pointInfo.findMany({
    where: and(
      eq(pointInfo.systemId, system.id),
      inArray(pointInfo.id, pointIds),
      eq(pointInfo.active, true)  // Only active points
    )
  });

  // Group by pointId and transform to MeasurementSeries
  const seriesMap = new Map<number, MeasurementSeries>();

  for (const row of dailyData) {
    const point = points.find(p => p.id === row.pointId);
    if (!point) continue;

    if (!seriesMap.has(row.pointId)) {
      seriesMap.set(row.pointId, {
        name: getPointDisplayPath(point),
        unit: point.metricUnit,
        data: [],
      });
    }

    const series = seriesMap.get(row.pointId)!;

    // Convert day string to timestamp (start of day in system timezone)
    const dayTimestamp = convertDayToTimestamp(row.day, system.timezoneOffsetMin);

    series.data.push({
      timestamp: dayTimestamp,
      avg: row.avg,
      min: row.min,
      max: row.max,
      first: row.first,
      last: row.last,
      dailyTotal: row.dailyTotal,
      dataQuality: row.intervalCount === 288 ? 'good' : 'partial',
    });
  }

  return Array.from(seriesMap.values());
}
```

**Performance Improvement**:

- Before: 30 days × 288 intervals × 20 points = **172,800 rows**
- After: 30 days × 20 points = **600 rows**
- **~290x fewer rows fetched!**
- Response time: seconds → milliseconds

---

### Phase 4: Testing & Validation

#### 4.1 Development Testing Workflow

**Step 1: Test Single Day Aggregation**

```bash
# In development, manually trigger aggregation for one day
# Via node script or direct function call
npx tsx -e "
import { aggregatePointDailyData } from './lib/point-aggregate-daily';
await aggregatePointDailyData(1586, 1, '2025-01-08');
console.log('Done');
"

# Verify results
sqlite3 dev.db "
SELECT
  system_id, point_id, day,
  avg, min, max, first, last,
  interval_count, sample_count
FROM point_readings_agg_1d
WHERE system_id = 1586 AND point_id = 1 AND day = '2025-01-08';
"

# Compare with 5-min aggregates
sqlite3 dev.db "
SELECT COUNT(*) as intervals
FROM point_readings_agg_5m
WHERE system_id = 1586 AND point_id = 1
  AND datetime(interval_end/1000, 'unixepoch') BETWEEN '2025-01-08' AND '2025-01-09';
-- Should be 288 for a complete day
"
```

**Step 2: Test Week Aggregation**

```bash
# Aggregate a week for all points in one system
npx tsx -e "
import { aggregateAllPointDailyData } from './lib/point-aggregate-daily';
await aggregateAllPointDailyData(1586, undefined, '2025-01-01', '2025-01-07');
console.log('Done');
"

# Check results
sqlite3 dev.db "
SELECT day, COUNT(DISTINCT point_id) as points
FROM point_readings_agg_1d
WHERE system_id = 1586
GROUP BY day
ORDER BY day;
"
```

**Step 3: Test API Endpoint**

```bash
# Test daily interval query via API
curl "http://localhost:3000/api/history?systemId=1586&startDate=2025-01-01T00:00:00Z&endDate=2025-01-07T23:59:59Z&interval=1d"

# Verify response:
# - Should use point_readings_agg_1d (check DB logs)
# - Should return one series per point
# - Should have one data point per day
# - Should be fast (< 500ms)
```

**Step 4: Compare with In-Memory Calculation**

```bash
# Before implementing DB query, save in-memory results
# After implementing, compare new results with saved results
# Values should match (within rounding errors)
```

#### 4.2 Validation Checks

**Data Quality Checks**:

```sql
-- Check interval counts (should be 288 for complete days)
SELECT
  day,
  AVG(interval_count) as avg_intervals,
  MIN(interval_count) as min_intervals,
  MAX(interval_count) as max_intervals
FROM point_readings_agg_1d
WHERE system_id = 1586
GROUP BY day
HAVING avg_intervals < 288;

-- Check for days with excessive errors
SELECT day, point_id, error_count
FROM point_readings_agg_1d
WHERE system_id = 1586 AND error_count > 50
ORDER BY error_count DESC;

-- Verify all active points have aggregates
SELECT
  pi.id,
  pi.display_name,
  COUNT(DISTINCT pra.day) as days_aggregated
FROM point_info pi
LEFT JOIN point_readings_agg_1d pra
  ON pi.system_id = pra.system_id AND pi.id = pra.point_id
WHERE pi.system_id = 1586 AND pi.active = true
GROUP BY pi.id
HAVING days_aggregated = 0;  -- Should be empty
```

**Timezone Boundary Checks**:

```sql
-- Verify day boundaries align with system local time
-- Check first and last 5-min interval for a day
SELECT
  pra5m.interval_end,
  datetime(pra5m.interval_end/1000, 'unixepoch') as utc_time,
  pra1d.day
FROM point_readings_agg_5m pra5m
JOIN point_readings_agg_1d pra1d
  ON pra5m.system_id = pra1d.system_id
  AND pra5m.point_id = pra1d.point_id
WHERE pra1d.system_id = 1586
  AND pra1d.point_id = 1
  AND pra1d.day = '2025-01-08'
ORDER BY pra5m.interval_end
LIMIT 5;  -- First intervals

-- Should start around 00:05 local time (14:05 UTC for AEST)
```

**Energy Calculation Checks**:

```sql
-- For energy points, verify daily_total makes sense
SELECT
  day,
  point_id,
  daily_total,
  first,
  last,
  (last - first) as calculated_delta
FROM point_readings_agg_1d
WHERE system_id = 1586
  AND daily_total IS NOT NULL
ORDER BY day DESC
LIMIT 10;

-- daily_total should roughly match (last - first) for cumulative energy
-- Or should be sum of intervals for interval energy
```

#### 4.3 Performance Testing

**Before vs After Comparison**:

```bash
# Test large date range query (e.g., 90 days)
time curl "http://localhost:3000/api/history?systemId=1586&startDate=2024-10-01T00:00:00Z&endDate=2025-01-07T23:59:59Z&interval=1d"

# Expected improvement:
# Before (in-memory): 5-10 seconds, 25,000+ rows
# After (pre-aggregated): < 1 second, ~2,700 rows
```

---

### Phase 5: View Data Modal Enhancement (Optional)

#### 5.1 Add Daily View Option

**File**: `components/ViewDataModal.tsx`

**Changes**:

1. **Update data source state**:

   ```typescript
   const [dataSource, setDataSource] = useState<"raw" | "5m" | "1d">("raw");
   ```

2. **Add daily button/tab**:

   ```tsx
   <Button
     variant={dataSource === "1d" ? "default" : "outline"}
     onClick={() => setDataSource("1d")}
   >
     Daily
   </Button>
   ```

3. **Update data fetching logic**:

   ```typescript
   const fetchData = async () => {
     const params = new URLSearchParams({
       systemId: String(systemId),
       startDate: startDate.toISOString(),
       endDate: endDate.toISOString(),
       interval:
         dataSource === "raw" ? "raw" : dataSource === "5m" ? "5m" : "1d",
     });

     const response = await fetch(`/api/history?${params}`);
     // ... handle response
   };
   ```

4. **Update date range handling**:
   ```typescript
   // For daily view, enforce minimum 1-day granularity
   // Adjust date picker to select whole days
   ```

**Benefits**:

- Users can view long-term trends efficiently
- Complements existing raw and 5-minute views
- Provides quick overview of historical performance

---

## Production Deployment

### Phase 6: Deployment & Backfill Strategy

#### 6.1 Pre-Deployment Checklist

**CRITICAL: Backup Production Database**

```bash
# Create Turso snapshot (instant, recommended)
~/.turso/turso db create liveone-snapshot-$(date +%Y%m%d-%H%M%S) \
  --from-db liveone-tokyo \
  --location aws-ap-northeast-1 \
  --wait

# Verify snapshot has data
~/.turso/turso db shell liveone-snapshot-YYYYMMDD-HHMMSS \
  "SELECT COUNT(*) FROM point_readings; SELECT COUNT(*) FROM point_readings_agg_5m;"

# Alternative: File-based backup
./scripts/utils/backup-prod-db.sh

# Verify backup is at least 6MB
ls -lh db-backups/ | tail -1
```

**Test Migration on Database Copy**:

```bash
# Extract recent backup
gunzip -c db-backups/liveone-tokyo-YYYYMMDD-HHMMSS.db.gz > /tmp/test.db

# Test migration
sqlite3 /tmp/test.db < migrations/00XX_add_point_readings_agg_1d.sql

# Verify table created
sqlite3 /tmp/test.db "
SELECT name FROM sqlite_master WHERE type='table' AND name='point_readings_agg_1d';
"

# Test aggregation on copy
npx tsx -e "
import { db } from './lib/db';  // Configure for /tmp/test.db
import { aggregatePointDailyData } from './lib/point-aggregate-daily';
await aggregatePointDailyData(1586, 1, '2025-01-08');
console.log('Migration test successful');
"
```

#### 6.2 Migration Application

**Step 1: Apply Migration to Production**

```bash
# Apply migration via Turso CLI
~/.turso/turso db shell liveone-tokyo < migrations/00XX_add_point_readings_agg_1d.sql

# Verify table created
~/.turso/turso db shell liveone-tokyo "
SELECT name FROM sqlite_master WHERE type='table' AND name='point_readings_agg_1d';
"

# Verify indexes
~/.turso/turso db shell liveone-tokyo "
SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='point_readings_agg_1d';
"
```

**Step 2: Deploy Code Changes**

```bash
# Ensure all code changes are committed
git add .
git commit -m "Implement daily aggregation for point-based systems"

# Push to main (triggers Vercel deployment)
git push origin main

# Monitor deployment
vercel ls
./scripts/vercel-build-log.sh
```

#### 6.3 Initial Data Population

**Option A: Conservative Single-Day Test** (Recommended First)

```bash
# Manually trigger yesterday's aggregation only
curl -X POST https://liveone.vercel.app/api/cron/daily \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -d '{"action": "update"}'

# Or use cookie auth
curl -X POST https://liveone.vercel.app/api/cron/daily \
  -H "Cookie: auth-token=..." \
  -d '{"action": "update"}'

# Verify one day's data was created
~/.turso/turso db shell liveone-tokyo "
SELECT COUNT(*) as rows, MIN(day) as first_day, MAX(day) as last_day
FROM point_readings_agg_1d;
"
```

**Option B: Incremental Backfill** (Week by Week)

```bash
# Manually trigger aggregation for specific date ranges
# Do this via direct script execution or API calls
# Test each week before proceeding to next

# Week 1: 2025-01-01 to 2025-01-07
npx tsx scripts/temp/backfill-points-daily.ts --start 2025-01-01 --end 2025-01-07

# Verify
~/.turso/turso db shell liveone-tokyo "
SELECT day, COUNT(DISTINCT point_id) as points
FROM point_readings_agg_1d
WHERE day BETWEEN '2025-01-01' AND '2025-01-07'
GROUP BY day;
"

# Week 2: Continue if Week 1 successful
# ... repeat ...
```

**Option C: Full Historical Backfill** (When Ready)

```bash
# Regenerate all historical daily data
# WARNING: This may take 10-30 minutes depending on data volume
curl -X POST https://liveone.vercel.app/api/cron/daily \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -d '{"action": "regenerate_points"}'

# Monitor progress in Vercel logs
vercel logs --follow

# Verify completion
~/.turso/turso db shell liveone-tokyo "
SELECT
  COUNT(*) as total_rows,
  COUNT(DISTINCT system_id) as systems,
  COUNT(DISTINCT point_id) as unique_points,
  MIN(day) as earliest_day,
  MAX(day) as latest_day
FROM point_readings_agg_1d;
"

# Expected: Thousands to tens of thousands of rows
# Depends on number of systems × points × days of history
```

#### 6.4 Monitoring & Verification

**Post-Deployment Checks**:

```bash
# 1. Verify daily cron is running successfully
# Check Vercel cron logs at 00:05 AEST

# 2. Query aggregated data via API
curl "https://liveone.vercel.app/api/history?systemId=1586&startDate=2025-01-01T00:00:00Z&endDate=2025-01-31T23:59:59Z&interval=1d"

# 3. Check response time (should be < 1s)
time curl "https://liveone.vercel.app/api/history?systemId=1586&startDate=2024-10-01T00:00:00Z&endDate=2025-01-07T23:59:59Z&interval=1d"

# 4. Verify data quality
~/.turso/turso db shell liveone-tokyo "
-- Check recent aggregations
SELECT day, COUNT(*) as points, AVG(interval_count) as avg_intervals
FROM point_readings_agg_1d
WHERE day >= date('now', '-7 days')
GROUP BY day
ORDER BY day DESC;

-- Should show 288 intervals for complete days
"

# 5. Monitor table growth
~/.turso/turso db shell liveone-tokyo "
SELECT
  'point_readings' as table_name, COUNT(*) as rows FROM point_readings
UNION ALL
SELECT 'point_readings_agg_5m', COUNT(*) FROM point_readings_agg_5m
UNION ALL
SELECT 'point_readings_agg_1d', COUNT(*) FROM point_readings_agg_1d;
"
```

**Performance Verification**:

```bash
# Compare query performance before/after
# Test on large date ranges (90+ days)

# Expected improvements:
# - Response time: 5-10s → < 1s
# - Rows fetched: 25,000+ → < 3,000
# - Memory usage: High → Low
```

#### 6.5 Rollback Plan (If Needed)

**If aggregation fails or causes issues**:

1. **Stop automatic aggregation**:

   ```bash
   # Temporarily disable cron in vercel.json
   # Or add feature flag to skip point aggregation
   ```

2. **Revert to in-memory aggregation**:

   ```bash
   # Restore previous version of point-readings-provider.ts
   # API will fall back to in-memory aggregation
   ```

3. **Clear bad data**:

   ```sql
   -- Delete specific day's data
   DELETE FROM point_readings_agg_1d WHERE day = 'YYYY-MM-DD';

   -- Or clear entire table
   DELETE FROM point_readings_agg_1d;
   ```

4. **Restore from snapshot if catastrophic**:
   ```bash
   # Restore from Turso snapshot
   # Or restore from file backup
   ```

---

## Open Questions

These questions need decisions before full implementation:

### Question 1: Energy Calculation Strategy

**Context**: Different vendors provide energy data differently:

- **Enphase**: Provides interval energy (`solarIntervalWh`) - sum these up
- **Selectronic**: Provides cumulative totals - calculate delta from previous day
- **Mondo/Fronius**: May vary by point type

**Options**:

**A. Use cumulative total differences** (like Selectronic):

```typescript
const dailyTotal = lastIntervalValue - firstIntervalValue;
```

- Pros: Simple, works for cumulative meters
- Cons: Doesn't work for interval energy points

**B. Sum interval energy** (like Enphase):

```typescript
const dailyTotal = intervals.reduce((sum, i) => sum + i.dailyTotal, 0);
```

- Pros: Works for interval energy
- Cons: Doesn't work for cumulative totals

**C. Detect based on point metadata**:

```typescript
if (point.metricType === "energy") {
  // Check if point has interval energy or cumulative total
  // Apply appropriate calculation
}
```

- Pros: Flexible, supports both types
- Cons: More complex, needs point metadata

**Recommendation**: Option C - Detect and apply appropriate logic based on point configuration.

**Decision needed**: Which approach to use?

---

### Question 2: Inactive Points Handling

**Context**: Points can be marked `active = false` to hide from UI.

**Options**:

**A. Include inactive points in daily aggregation**:

- Pros: Data preserved if point is re-enabled later
- Cons: Unnecessary processing for disabled points

**B. Exclude inactive points from aggregation**:

- Pros: Saves processing time
- Cons: Historical data lost if point re-enabled

**C. Aggregate but mark with flag**:

- Add `is_active` boolean to aggregated data
- Pros: Best of both worlds
- Cons: More complex schema

**Recommendation**: Option A - Include inactive points. Storage is cheap, data is valuable.

**Decision needed**: Confirm approach.

---

### Question 3: Migration Rollout Timeline

**Context**: We can populate historical data in different ways.

**Options**:

**A. Conservative (Recommended)**:

1. Deploy migration + code
2. Test single day manually
3. Test one week
4. Run full backfill when confident

**B. Aggressive**:

1. Deploy migration + code
2. Immediately run full backfill
3. Monitor for issues

**C. Incremental**:

1. Deploy migration + code
2. Let daily cron populate new days naturally
3. Backfill historical data week by week manually
4. Full table ready in ~2-3 weeks

**Recommendation**: Option A - Test carefully before full backfill.

**Decision needed**: Confirm rollout approach.

---

### Question 4: Composite Systems Handling

**Context**: Composite systems (like multi-battery setups) query `point_readings_agg_5m` for daily intervals and aggregate in memory.

**File**: `lib/history/composite-provider.ts`

**Options**:

**A. Make composite systems use point_readings_agg_1d**:

- Update composite provider to query daily table
- Pros: Consistent with other point systems
- Cons: Need to test composite-specific logic

**B. Leave composite systems as-is**:

- They continue to aggregate in memory
- Pros: Less risk, isolated change
- Cons: Inconsistent approach

**Recommendation**: Option A - Update for consistency and performance.

**Decision needed**: Should composite systems use the new daily table?

---

## Files to Create/Modify Summary

### New Files

| File                                            | Purpose                          |
| ----------------------------------------------- | -------------------------------- |
| `migrations/00XX_add_point_readings_agg_1d.sql` | Database migration               |
| `lib/point-aggregate-daily.ts`                  | Daily aggregation logic          |
| `scripts/temp/backfill-points-daily.ts`         | Optional: Manual backfill script |
| `docs/DAILY_PLAN.md`                            | This file (implementation plan)  |

### Modified Files

| File                                     | Changes                                          |
| ---------------------------------------- | ------------------------------------------------ |
| `lib/db/schema-monitoring-points.ts`     | Add `pointReadingsAgg1d` table definition        |
| `app/api/cron/daily/route.ts`            | Integrate point daily aggregation                |
| `lib/history/point-readings-provider.ts` | Use daily table instead of in-memory aggregation |
| `components/ViewDataModal.tsx`           | (Optional) Add daily view option                 |
| `lib/history/composite-provider.ts`      | (Optional) Update to use daily table             |

### Documentation Updates

| File                       | Updates                                |
| -------------------------- | -------------------------------------- |
| `docs/POINTS.md`           | Document daily aggregation for points  |
| `docs/DAILY_AGGREGATES.md` | Add points section                     |
| `docs/SCHEMA.md`           | Document `point_readings_agg_1d` table |

---

## Timeline Estimates

| Phase                              | Estimated Time                         |
| ---------------------------------- | -------------------------------------- |
| **Phase 1**: Schema + Core Logic   | 2-3 hours                              |
| **Phase 2**: Cron Integration      | 1 hour                                 |
| **Phase 3**: API Integration       | 1 hour                                 |
| **Phase 4**: Testing & Validation  | 2-3 hours                              |
| **Phase 5**: View Modal (Optional) | 1 hour                                 |
| **Phase 6**: Production Deployment | 1-2 hours                              |
| **Backfill Time**                  | 10-30 minutes (depends on data volume) |

**Total Development Time**: ~8-10 hours

**Total Project Time**: ~1-2 days (including testing and deployment)

---

## Success Criteria

✅ **Functional**:

- [ ] Daily aggregation runs automatically at 00:05 AEST
- [ ] Aggregation completes successfully for all point systems
- [ ] API returns correct daily data from database table
- [ ] Historical backfill completes without errors

✅ **Performance**:

- [ ] Daily queries return in < 1 second (vs 5-10s before)
- [ ] Database queries fetch ~290x fewer rows
- [ ] API memory usage significantly reduced

✅ **Data Quality**:

- [ ] interval_count = 288 for complete days
- [ ] Aggregated values match spot-checked 5-min data
- [ ] Timezone boundaries align with system local time
- [ ] Energy calculations make sense for different point types

✅ **Operational**:

- [ ] Cron job logs show successful completion
- [ ] No errors in Vercel logs
- [ ] Table size grows predictably (~X rows per day)
- [ ] View Data modal works with daily data (if implemented)

---

## References

### Related Documentation

- [docs/SCHEMA.md](./SCHEMA.md) - Database schema
- [docs/POINTS.md](./POINTS.md) - Points system overview
- [docs/DAILY_AGGREGATES.md](./DAILY_AGGREGATES.md) - Daily aggregation for readings
- [docs/API.md](./API.md) - API documentation

### Key Files

- [lib/db/aggregate-daily.ts](../lib/db/aggregate-daily.ts) - Template for daily aggregation
- [lib/point-aggregation-helper.ts](../lib/point-aggregation-helper.ts) - 5-min aggregation logic
- [app/api/cron/daily/route.ts](../app/api/cron/daily/route.ts) - Daily cron job
- [lib/history/point-readings-provider.ts](../lib/history/point-readings-provider.ts) - Point data provider

### Database Tables

- `point_info` - Point metadata (subsystem, type, metricType, etc.)
- `point_readings` - Raw time-series data
- `point_readings_agg_5m` - 5-minute aggregates ✅
- `point_readings_agg_1d` - Daily aggregates (TO BE CREATED)

---

**Last Updated**: 2025-11-08
**Status**: Ready for implementation pending decisions on open questions
