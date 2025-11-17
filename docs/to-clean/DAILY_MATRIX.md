# Daily Energy Flow Matrix

## Overview

### Problem Statement

The 30D view in the dashboard currently shows inaccurate energy values for bidirectional flows (battery charge/discharge, grid import/export). This occurs because:

1. Daily aggregation averages power values over 24 hours
2. Battery charging (negative power) and discharging (positive power) average together
3. The averaged value approaches zero, losing directional information
4. Energy calculation: `power.avg × 24 hours` produces incorrect results

**Example:**

- Battery charges at 5 kW for 4 hours: -5 kW × 4h = -20 kWh
- Battery discharges at 2 kW for 10 hours: 2 kW × 10h = 20 kWh
- Daily average: (-20 + 20) / 24 = 0 kW
- Calculated energy: 0 kW × 24h = 0 kWh ✗
- Actual charge energy: 20 kWh ✓
- Actual discharge energy: 20 kWh ✓

### Solution Approach

Calculate energy flow matrices server-side from 5-minute aggregated data before averaging occurs:

1. **Daily Cron Job** (00:05 AM): Process previous day's 5-minute data for all systems
2. **Split Bidirectional Series**: Separate battery/grid into charge/discharge using actual 5-min power values
3. **Calculate Energy Flows**: Use existing `calculateEnergyFlowMatrix()` function on 5-min data
4. **Persist Results**: Store source→load energy flows in `energy_flow_matrix_1d` table
5. **Query for 30D**: Aggregate pre-calculated daily flows instead of calculating from averaged data

### Benefits

- ✅ **Accurate 30D energy values**: Calculated from granular data before averaging
- ✅ **Fast queries**: Simple aggregation of pre-calculated flows (~50ms vs ~5s)
- ✅ **Historical accuracy**: Backfill provides correct values for all historical periods
- ✅ **Consistent with current code**: Reuses existing matrix calculation logic
- ✅ **Flexible**: Supports real points and synthetic series (rest of house)

### Trade-offs

- ❌ **Additional storage**: ~10-20 rows per system per day (~300 KB/year/system)
- ❌ **Nightly processing**: ~1-5 minutes per system per year of data
- ❌ **Migration effort**: Requires backfill of historical data

---

## Database Schema

### Table Definition

```sql
CREATE TABLE energy_flow_matrix_1d (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id TEXT NOT NULL,
    day TEXT NOT NULL,  -- YYYY-MM-DD format (system local time)
    created_at INTEGER NOT NULL,  -- Unix epoch milliseconds
    updated_at INTEGER NOT NULL,  -- Unix epoch milliseconds

    -- Source identifier (energy provider)
    source_path TEXT NOT NULL,  -- e.g., "source.solar.local", "source.battery", "source.grid"
    source_point_system_id TEXT,  -- NULL for synthetic sources
    source_point_index INTEGER,   -- NULL for synthetic sources

    -- Load identifier (energy consumer)
    load_path TEXT NOT NULL,    -- e.g., "load.hws", "load.battery", "load.rest_of_house"
    load_point_system_id TEXT,  -- NULL for synthetic loads
    load_point_index INTEGER,   -- NULL for synthetic loads

    -- Energy flow value
    energy_kwh REAL NOT NULL,   -- Energy flowing from source to load (always >= 0)

    -- Data quality
    sample_count INTEGER,       -- Number of 5-min intervals used in calculation

    -- Metadata
    version INTEGER DEFAULT 1,

    FOREIGN KEY (system_id) REFERENCES systems (id),
    FOREIGN KEY (source_point_system_id, source_point_index)
        REFERENCES points (system_id, index),
    FOREIGN KEY (load_point_system_id, load_point_index)
        REFERENCES points (system_id, index)
);

-- Indexes for efficient querying
CREATE UNIQUE INDEX idx_energy_flow_matrix_1d_unique
    ON energy_flow_matrix_1d(system_id, day, source_path, load_path);

CREATE INDEX idx_energy_flow_matrix_1d_system_day
    ON energy_flow_matrix_1d(system_id, day);

CREATE INDEX idx_energy_flow_matrix_1d_day
    ON energy_flow_matrix_1d(day);

CREATE INDEX idx_energy_flow_matrix_1d_source_point
    ON energy_flow_matrix_1d(source_point_system_id, source_point_index)
    WHERE source_point_system_id IS NOT NULL;

CREATE INDEX idx_energy_flow_matrix_1d_load_point
    ON energy_flow_matrix_1d(load_point_system_id, load_point_index)
    WHERE load_point_system_id IS NOT NULL;
```

### Field Descriptions

| Field                    | Type    | Description                                              |
| ------------------------ | ------- | -------------------------------------------------------- |
| `system_id`              | TEXT    | System identifier (may be composite system)              |
| `day`                    | TEXT    | Date in YYYY-MM-DD format (system local time zone)       |
| `source_path`            | TEXT    | Path identifier for energy source (see Path Conventions) |
| `source_point_system_id` | TEXT    | System ID of source point (NULL for synthetic)           |
| `source_point_index`     | INTEGER | Point index of source (NULL for synthetic)               |
| `load_path`              | TEXT    | Path identifier for energy load (see Path Conventions)   |
| `load_point_system_id`   | TEXT    | System ID of load point (NULL for synthetic)             |
| `load_point_index`       | INTEGER | Point index of load (NULL for synthetic)                 |
| `energy_kwh`             | REAL    | Energy flow amount in kWh (always positive)              |
| `sample_count`           | INTEGER | Number of 5-min intervals with valid data                |
| `version`                | INTEGER | Schema version for future migrations                     |

### Example Data

```sql
-- Real point to real point: Solar → Hot Water
INSERT INTO energy_flow_matrix_1d VALUES
(1, '10000', '2025-11-13', 1731456000000, 1731456000000,
 'source.solar.local', '10000', 15,  -- Solar point from system 10000
 'load.hws', '10000', 42,            -- Hot water point from system 10000
 45.2, 288, 1);

-- Real point (split) to synthetic: Battery Discharge → Rest of House
INSERT INTO energy_flow_matrix_1d VALUES
(2, '10000', '2025-11-13', 1731456000000, 1731456000000,
 'source.battery', '10000', 38,      -- Links to bidi.battery point
 'load.rest_of_house', NULL, NULL,   -- Synthetic load
 12.3, 288, 1);

-- Composite system: Solar from child → Load in parent
INSERT INTO energy_flow_matrix_1d VALUES
(3, '10001', '2025-11-13', 1731456000000, 1731456000000,
 'source.solar.local', '10002', 8,   -- Solar from child system 10002
 'load.pool', '10001', 55,           -- Pool in parent system 10001
 78.4, 288, 1);
```

---

## Path Conventions

### Source Paths (Energy Providers)

| Path                  | Description             | Point Reference                       |
| --------------------- | ----------------------- | ------------------------------------- |
| `source.solar`        | Total solar generation  | Actual point (if combined)            |
| `source.solar.local`  | Local solar generation  | Actual point                          |
| `source.solar.remote` | Remote solar generation | Actual point                          |
| `source.battery`      | Battery discharge       | Links to `bidi.battery` point (split) |
| `source.grid`         | Grid import             | Links to `bidi.grid` point (split)    |

### Load Paths (Energy Consumers)

| Path                 | Description                         | Point Reference                       |
| -------------------- | ----------------------------------- | ------------------------------------- |
| `load`               | Master load (if available)          | Actual point                          |
| `load.{subtype}`     | Specific load (e.g., hws, ev, pool) | Actual point                          |
| `load.battery`       | Battery charge                      | Links to `bidi.battery` point (split) |
| `load.grid`          | Grid export                         | Links to `bidi.grid` point (split)    |
| `load.rest_of_house` | Calculated remainder                | Synthetic (NULL point ref)            |

### Synthetic vs. Point-Backed Series

**Point-Backed Series:**

- Have `point_system_id` and `point_index` values
- Labels fetched from `points.name` at query time
- User can rename points, labels automatically update
- Examples: `source.solar.local`, `load.hws`, `load.ev`

**Synthetic Series:**

- Have `point_system_id` and `point_index` as NULL
- Labels generated from path at query time
- Examples: `load.rest_of_house`

**Split Bidirectional Series:**

- Have `point_system_id` and `point_index` linking to original bidirectional point
- Labels derived from original point name with suffix
- Examples: `source.battery` (from `bidi.battery`), `load.grid` (from `bidi.grid`)

### Path Construction Rules

1. **Real points**: Use point metadata: `{type}.{subtype}[.{extension}]`
   - Example: `source.solar.local` (type=source, subtype=solar, extension=local)

2. **Split bidirectional**:
   - Source side: `source.{subtype}` (e.g., `source.battery`, `source.grid`)
   - Load side: `load.{subtype}` (e.g., `load.battery`, `load.grid`)

3. **Synthetic calculations**: Fixed path names
   - `load.rest_of_house` - Always this exact path

---

## Daily Calculation Process

### High-Level Algorithm

```
For each system:
  For yesterday:
    1. Query all 5-minute power data for the day (288 intervals)
    2. Transform to time series format (one array per point)
    3. Split bidirectional series (battery, grid) into charge/discharge
    4. Calculate synthetic "Rest of House" load
    5. Build point-to-path mapping (track point IDs)
    6. Run existing calculateEnergyFlowMatrix() on 5-min data
    7. Insert matrix results into energy_flow_matrix_1d table
```

### Detailed Implementation

#### Step 1: Query 5-Minute Data

```typescript
// File: lib/energy-flow-matrix-daily.ts

async function query5MinutePowerData(
  systemId: string,
  day: string, // YYYY-MM-DD
): Promise<PowerReading[]> {
  const startOfDay = new Date(`${day}T00:00:00`);
  const endOfDay = new Date(`${day}T23:59:59`);
  const startMs = startOfDay.getTime();
  const endMs = endOfDay.getTime();

  const readings = await db
    .select({
      pointId: pointReadingsAgg5m.pointId,
      intervalEnd: pointReadingsAgg5m.intervalEnd,
      avg: pointReadingsAgg5m.avg,
      // Point metadata
      systemId: points.systemId,
      pointIndex: points.index,
      name: points.name,
      type: points.type,
      subtype: points.subtype,
      extension: points.extension,
      metricType: points.metricType,
      transform: points.transform,
    })
    .from(pointReadingsAgg5m)
    .innerJoin(points, eq(points.index, pointReadingsAgg5m.pointId))
    .where(
      and(
        eq(pointReadingsAgg5m.systemId, systemId),
        gte(pointReadingsAgg5m.intervalEnd, startMs),
        lte(pointReadingsAgg5m.intervalEnd, endMs),
        eq(points.metricType, "power"), // Only power metrics
      ),
    )
    .orderBy(pointReadingsAgg5m.intervalEnd);

  return readings;
}
```

#### Step 2: Transform to Time Series

```typescript
interface TimeSeries {
  path: string;
  label: string;
  data: (number | null)[];
  timestamps: Date[];
  pointSystemId: string | null;
  pointIndex: number | null;
}

function buildTimeSeries(
  readings: PowerReading[],
  startOfDay: Date,
): Map<string, TimeSeries> {
  const timeSeriesMap = new Map<string, TimeSeries>();

  // Create 288 timestamp slots (24h × 12 intervals/hour)
  const timestamps: Date[] = [];
  for (let i = 0; i < 288; i++) {
    timestamps.push(new Date(startOfDay.getTime() + i * 5 * 60 * 1000));
  }

  // Group readings by point
  for (const reading of readings) {
    const path = buildPath(reading);

    if (!timeSeriesMap.has(path)) {
      timeSeriesMap.set(path, {
        path,
        label: reading.name,
        data: new Array(288).fill(null),
        timestamps,
        pointSystemId: reading.systemId,
        pointIndex: reading.pointIndex,
      });
    }

    // Find interval index (0-287)
    const intervalIndex = Math.floor(
      (reading.intervalEnd - startOfDay.getTime()) / (5 * 60 * 1000),
    );

    if (intervalIndex >= 0 && intervalIndex < 288) {
      // Apply transform (e.g., invert for negative flows)
      const value = applyTransform(reading.avg, reading.transform);
      timeSeriesMap.get(path)!.data[intervalIndex] = value / 1000; // W → kW
    }
  }

  return timeSeriesMap;
}

function buildPath(reading: PowerReading): string {
  const parts = [reading.type];
  if (reading.subtype) parts.push(reading.subtype);
  if (reading.extension) parts.push(reading.extension);
  return parts.join(".");
}
```

#### Step 3: Split Bidirectional Series

```typescript
function splitBidirectionalSeries(
  timeSeriesMap: Map<string, TimeSeries>,
): void {
  // Battery: bidi.battery → source.battery + load.battery
  const batteryBidi = timeSeriesMap.get("bidi.battery");
  if (batteryBidi) {
    timeSeriesMap.set("source.battery", {
      path: "source.battery",
      label: `${batteryBidi.label} Discharge`,
      data: batteryBidi.data.map((v) => (v !== null && v > 0 ? v : 0)),
      timestamps: batteryBidi.timestamps,
      pointSystemId: batteryBidi.pointSystemId, // Links to bidi.battery
      pointIndex: batteryBidi.pointIndex,
    });

    timeSeriesMap.set("load.battery", {
      path: "load.battery",
      label: `${batteryBidi.label} Charge`,
      data: batteryBidi.data.map((v) =>
        v !== null && v < 0 ? Math.abs(v) : 0,
      ),
      timestamps: batteryBidi.timestamps,
      pointSystemId: batteryBidi.pointSystemId, // Links to bidi.battery
      pointIndex: batteryBidi.pointIndex,
    });

    timeSeriesMap.delete("bidi.battery");
  }

  // Grid: bidi.grid → source.grid + load.grid
  const gridBidi = timeSeriesMap.get("bidi.grid");
  if (gridBidi) {
    timeSeriesMap.set("source.grid", {
      path: "source.grid",
      label: `${gridBidi.label} Import`,
      data: gridBidi.data.map((v) => (v !== null && v > 0 ? v : 0)),
      timestamps: gridBidi.timestamps,
      pointSystemId: gridBidi.pointSystemId,
      pointIndex: gridBidi.pointIndex,
    });

    timeSeriesMap.set("load.grid", {
      path: "load.grid",
      label: `${gridBidi.label} Export`,
      data: gridBidi.data.map((v) => (v !== null && v < 0 ? Math.abs(v) : 0)),
      timestamps: gridBidi.timestamps,
      pointSystemId: gridBidi.pointSystemId,
      pointIndex: gridBidi.pointIndex,
    });

    timeSeriesMap.delete("bidi.grid");
  }
}
```

#### Step 4: Calculate Rest of House

```typescript
function calculateRestOfHouse(timeSeriesMap: Map<string, TimeSeries>): void {
  // Total generation = all sources
  const generationSeries = Array.from(timeSeriesMap.values()).filter((s) =>
    s.path.startsWith("source."),
  );

  const totalGeneration = new Array(288).fill(0);
  for (const series of generationSeries) {
    for (let i = 0; i < 288; i++) {
      if (series.data[i] !== null) {
        totalGeneration[i] += series.data[i];
      }
    }
  }

  // Known loads = battery charge + grid export + specific loads
  const loadSeries = Array.from(timeSeriesMap.values()).filter(
    (s) => s.path.startsWith("load.") && s.path !== "load",
  ); // Exclude master load

  const knownLoads = new Array(288).fill(0);
  for (const series of loadSeries) {
    for (let i = 0; i < 288; i++) {
      if (series.data[i] !== null) {
        knownLoads[i] += series.data[i];
      }
    }
  }

  // Rest of House = Generation - Known Loads (or Master Load - Known Loads if available)
  const masterLoad = timeSeriesMap.get("load");
  const restOfHouseData = new Array(288);

  for (let i = 0; i < 288; i++) {
    if (masterLoad && masterLoad.data[i] !== null) {
      // Case 1: Use master load as reference
      restOfHouseData[i] = Math.max(0, masterLoad.data[i] - knownLoads[i]);
    } else if (totalGeneration[i] > 0) {
      // Case 2: Use generation as reference
      restOfHouseData[i] = Math.max(0, totalGeneration[i] - knownLoads[i]);
    } else {
      restOfHouseData[i] = null;
    }
  }

  timeSeriesMap.set("load.rest_of_house", {
    path: "load.rest_of_house",
    label: "Rest of House",
    data: restOfHouseData,
    timestamps: generationSeries[0]?.timestamps || [],
    pointSystemId: null, // Synthetic
    pointIndex: null,
  });
}
```

#### Step 5: Run Energy Flow Matrix Calculation

```typescript
import { calculateEnergyFlowMatrix } from "@/lib/energy-flow-matrix";

function calculateMatrix(
  timeSeriesMap: Map<string, TimeSeries>,
): EnergyFlowMatrix {
  // Separate sources and loads
  const generationSeries = Array.from(timeSeriesMap.values()).filter((s) =>
    s.path.startsWith("source."),
  );

  const loadSeries = Array.from(timeSeriesMap.values()).filter((s) =>
    s.path.startsWith("load."),
  );

  // Convert to format expected by calculateEnergyFlowMatrix
  const generation = {
    timestamps: generationSeries[0]?.timestamps || [],
    series: generationSeries.map((s) => ({
      id: s.path,
      description: s.label,
      data: s.data,
      color: getColorForPath(s.path, s.label),
      seriesType: "power" as const,
    })),
    mode: "power" as const,
  };

  const load = {
    timestamps: loadSeries[0]?.timestamps || [],
    series: loadSeries.map((s) => ({
      id: s.path,
      description: s.label,
      data: s.data,
      color: getColorForPath(s.path, s.label),
      seriesType: "power" as const,
    })),
    mode: "power" as const,
  };

  // Use existing energy flow matrix calculation
  return calculateEnergyFlowMatrix({ generation, load });
}
```

#### Step 6: Store Results

```typescript
async function storeMatrixResults(
  systemId: string,
  day: string,
  matrix: EnergyFlowMatrix,
  timeSeriesMap: Map<string, TimeSeries>,
): Promise<number> {
  const records = [];
  const now = Date.now();

  // Count non-null samples
  const sampleCount =
    timeSeriesMap
      .values()
      .next()
      .value?.data.filter((v: number | null) => v !== null).length || 0;

  for (let srcIdx = 0; srcIdx < matrix.sources.length; srcIdx++) {
    for (let loadIdx = 0; loadIdx < matrix.loads.length; loadIdx++) {
      const energyKwh = matrix.flows[srcIdx][loadIdx];

      // Only store non-trivial flows (> 0.001 kWh = 1 Wh)
      if (energyKwh > 0.001) {
        const sourceId = matrix.sources[srcIdx].id;
        const loadId = matrix.loads[loadIdx].id;

        // Get point references from time series map
        const sourceSeries = timeSeriesMap.get(sourceId);
        const loadSeries = timeSeriesMap.get(loadId);

        records.push({
          system_id: systemId,
          day,
          source_path: sourceId,
          source_point_system_id: sourceSeries?.pointSystemId || null,
          source_point_index: sourceSeries?.pointIndex || null,
          load_path: loadId,
          load_point_system_id: loadSeries?.pointSystemId || null,
          load_point_index: loadSeries?.pointIndex || null,
          energy_kwh: energyKwh,
          sample_count: sampleCount,
          created_at: now,
          updated_at: now,
          version: 1,
        });
      }
    }
  }

  // Insert all records
  if (records.length > 0) {
    await db.insert(energyFlowMatrix1d).values(records);
  }

  return records.length;
}
```

#### Main Function

```typescript
export async function calculateDailyEnergyMatrix(
  systemId: string,
  day: string, // YYYY-MM-DD
): Promise<number> {
  // 1. Query 5-minute power data
  const readings = await query5MinutePowerData(systemId, day);

  if (readings.length === 0) {
    return 0; // No data for this day
  }

  // 2. Build time series
  const startOfDay = new Date(`${day}T00:00:00`);
  const timeSeriesMap = buildTimeSeries(readings, startOfDay);

  // 3. Split bidirectional series
  splitBidirectionalSeries(timeSeriesMap);

  // 4. Calculate rest of house
  calculateRestOfHouse(timeSeriesMap);

  // 5. Calculate energy flow matrix
  const matrix = calculateMatrix(timeSeriesMap);

  // 6. Store results
  const flowCount = await storeMatrixResults(
    systemId,
    day,
    matrix,
    timeSeriesMap,
  );

  return flowCount;
}
```

---

## Label Resolution

### Label Sources

Labels are determined at query time, not stored in the matrix table:

1. **Point-backed series**: Fetch from `points.name`
2. **Synthetic series**: Generate from path
3. **Split bidirectional**: Derive from original point name + suffix

### Query with Label Resolution

```typescript
async function queryEnergyFlowMatrix(
  systemId: string,
  startDate: string,
  endDate: string,
) {
  // Query flows with point joins
  const flows = await db
    .select({
      day: energyFlowMatrix1d.day,
      sourcePath: energyFlowMatrix1d.sourcePath,
      sourcePointSystemId: energyFlowMatrix1d.sourcePointSystemId,
      sourcePointIndex: energyFlowMatrix1d.sourcePointIndex,
      sourcePointName: points_source.name,
      loadPath: energyFlowMatrix1d.loadPath,
      loadPointSystemId: energyFlowMatrix1d.loadPointSystemId,
      loadPointIndex: energyFlowMatrix1d.loadPointIndex,
      loadPointName: points_load.name,
      energyKwh: energyFlowMatrix1d.energyKwh,
      sampleCount: energyFlowMatrix1d.sampleCount,
    })
    .from(energyFlowMatrix1d)
    .leftJoin(
      points_source,
      and(
        eq(energyFlowMatrix1d.sourcePointSystemId, points_source.systemId),
        eq(energyFlowMatrix1d.sourcePointIndex, points_source.index),
      ),
    )
    .leftJoin(
      points_load,
      and(
        eq(energyFlowMatrix1d.loadPointSystemId, points_load.systemId),
        eq(energyFlowMatrix1d.loadPointIndex, points_load.index),
      ),
    )
    .where(
      and(
        eq(energyFlowMatrix1d.systemId, systemId),
        gte(energyFlowMatrix1d.day, startDate),
        lte(energyFlowMatrix1d.day, endDate),
      ),
    );

  // Generate labels for each flow
  return flows.map((flow) => ({
    ...flow,
    sourceLabel: generateLabel(flow.sourcePath, flow.sourcePointName),
    loadLabel: generateLabel(flow.loadPath, flow.loadPointName),
  }));
}
```

### Label Generation Logic

```typescript
function generateLabel(path: string, pointName: string | null): string {
  // If we have a point name, use it (keeps labels current as points are renamed)
  if (pointName) {
    // For split bidirectional series, add directional suffix
    if (path.includes(".battery")) {
      if (path.startsWith("source.")) return `${pointName} Discharge`;
      if (path.startsWith("load.")) return `${pointName} Charge`;
    }
    if (path.includes(".grid")) {
      if (path.startsWith("source.")) return `${pointName} Import`;
      if (path.startsWith("load.")) return `${pointName} Export`;
    }
    return pointName;
  }

  // Synthetic series - generate label from path
  const syntheticLabels: Record<string, string> = {
    "load.rest_of_house": "Rest of House",
    "source.battery": "Battery Discharge",
    "load.battery": "Battery Charge",
    "source.grid": "Grid Import",
    "load.grid": "Grid Export",
  };

  if (syntheticLabels[path]) {
    return syntheticLabels[path];
  }

  // Fallback: humanize the path
  return path
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
```

### Benefits of Dynamic Label Resolution

1. **Always Current**: User renames "Hot Water System" → "HWS", all historical data reflects new name
2. **No Duplication**: Don't store label strings millions of times
3. **Consistent**: Same label logic as current client-side implementation
4. **Flexible**: Can change label generation rules without data migration

---

## Cron Job Implementation

### Schedule

**Time**: 00:05 AM daily (system local time)
**Trigger**: Vercel Cron or similar scheduler
**Frequency**: Once per day

**Why 00:05?**

- Runs after daily point aggregation completes (00:00-00:04)
- Processes previous day's complete data
- Allows aggregation job to finish before starting matrix calculation

### API Endpoint

**Location**: `/app/api/cron/daily-energy-matrix/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { systems as systemsTable } from "@/lib/db/schema";
import { calculateDailyEnergyMatrix } from "@/lib/energy-flow-matrix-daily";

export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Calculate date for yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const day = yesterday.toISOString().split("T")[0]; // YYYY-MM-DD

    console.log(`[Daily Matrix Cron] Starting for ${day}`);

    // Get all systems
    const systems = await db.select().from(systemsTable);

    const results = [];
    let totalFlows = 0;
    let systemsProcessed = 0;
    let systemsFailed = 0;

    for (const system of systems) {
      try {
        const flowCount = await calculateDailyEnergyMatrix(system.id, day);
        results.push({
          systemId: system.id,
          status: "success",
          flowCount,
        });
        totalFlows += flowCount;
        systemsProcessed++;
        console.log(`  ✓ ${system.id}: ${flowCount} flows`);
      } catch (error) {
        results.push({
          systemId: system.id,
          status: "error",
          error: error.message,
        });
        systemsFailed++;
        console.error(`  ✗ ${system.id}:`, error);
      }
    }

    console.log(
      `[Daily Matrix Cron] Complete: ${systemsProcessed}/${systems.length} systems, ${totalFlows} total flows`,
    );

    return NextResponse.json({
      success: true,
      day,
      systemsProcessed,
      systemsFailed,
      totalFlows,
      results,
    });
  } catch (error) {
    console.error("[Daily Matrix Cron] Failed:", error);
    return NextResponse.json(
      { error: "Internal server error", message: error.message },
      { status: 500 },
    );
  }
}
```

### Vercel Cron Configuration

**File**: `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/cron/daily-energy-matrix",
      "schedule": "5 0 * * *"
    }
  ]
}
```

### Error Handling

1. **System-level errors**: Continue processing other systems, log failures
2. **Missing data**: Skip days with no 5-minute data, return 0 flows
3. **Database errors**: Catch and log, return error status
4. **Timeout protection**: Process within Vercel's function timeout limits

### Monitoring

Log key metrics:

- Systems processed / failed
- Total flows calculated
- Processing time per system
- Errors encountered

Alert on:

- More than 10% systems failing
- Processing time exceeding expected duration
- No data available for previous day

---

## Backfill Strategy

### Overview

Backfill historical energy flow matrices for all days that have 5-minute data but no matrix data.

### Backfill Script

**Location**: `/scripts/backfill-energy-flow-matrix.ts`

**Key Features:**

- Process all systems or specific systems
- Date range filtering
- Batch processing to avoid memory issues
- Skip existing data (or force reprocess)
- Progress tracking and error recovery
- Parallel processing support

### Command-Line Interface

```bash
# Basic usage - backfill all systems, all dates
npx tsx scripts/backfill-energy-flow-matrix.ts

# Specific system
npx tsx scripts/backfill-energy-flow-matrix.ts --system 10000

# Multiple systems
npx tsx scripts/backfill-energy-flow-matrix.ts --system 10000,10001,10002

# Date range
npx tsx scripts/backfill-energy-flow-matrix.ts \
  --start 2025-01-01 \
  --end 2025-11-13

# Batch size (days per batch)
npx tsx scripts/backfill-energy-flow-matrix.ts --batch-size 90

# Force reprocess existing data
npx tsx scripts/backfill-energy-flow-matrix.ts --force

# Combined
npx tsx scripts/backfill-energy-flow-matrix.ts \
  --system 10000 \
  --start 2025-10-01 \
  --end 2025-11-13 \
  --batch-size 60
```

### Backfill Options

| Option            | Description                | Default                 |
| ----------------- | -------------------------- | ----------------------- |
| `--system` / `-s` | Comma-separated system IDs | All systems             |
| `--start`         | Start date (YYYY-MM-DD)    | Earliest available data |
| `--end`           | End date (YYYY-MM-DD)      | Yesterday               |
| `--batch-size`    | Days per batch             | 30                      |
| `--force`         | Reprocess existing data    | false (skip existing)   |

### Performance Estimates

**Processing Times:**

- Per day per system: ~100-500ms
- 1 system, 1 year (365 days): ~5-25 minutes
- 10 systems, 1 year: ~50-250 minutes
- 100 systems, 1 year: ~8-40 hours

**Factors affecting performance:**

- Number of points per system
- Data density (missing intervals)
- Number of flows (sources × loads)
- Database performance

### Backfill Strategies

#### Strategy 1: All at Once (Simplest)

```bash
npx tsx scripts/backfill-energy-flow-matrix.ts
```

**When to use:**

- Small dataset (< 100 systems, < 1 year)
- One-time setup
- Sufficient time available

**Pros:** Simple, complete
**Cons:** Long running, resource intensive

#### Strategy 2: By System (Parallel)

```bash
# Run multiple systems in parallel
for system in 10000 10001 10002; do
  npx tsx scripts/backfill-energy-flow-matrix.ts --system $system &
done
wait
```

**When to use:**

- Many systems to process
- Want faster completion
- Have parallel execution capability

**Pros:** Faster, parallelizable
**Cons:** Requires orchestration

#### Strategy 3: By Date Range (Incremental)

```bash
# Process one year at a time
for year in 2024 2025; do
  npx tsx scripts/backfill-energy-flow-matrix.ts \
    --start $year-01-01 \
    --end $year-12-31
done
```

**When to use:**

- Very large date range
- Want resumable process
- Prefer incremental approach

**Pros:** Manageable chunks, resumable
**Cons:** More manual steps

#### Strategy 4: Weekly Cron (Gradual)

```bash
# Add to crontab: backfill 90 days at a time, weekly
0 2 * * 0 npx tsx scripts/backfill-energy-flow-matrix.ts --batch-size 90
```

**When to use:**

- Non-urgent backfill
- Want low system impact
- Gradual completion acceptable

**Pros:** Low impact, automatic
**Cons:** Slow completion (weeks/months)

### Error Recovery

The backfill script automatically:

1. **Continues on error**: One failed day doesn't stop the batch
2. **Logs all errors**: Review and identify patterns
3. **Returns error count**: Exit code reflects success/failure
4. **Skips existing by default**: `--force` to reprocess

**To retry failed days:**

```bash
# From backfill log, extract failed days
grep "✗" backfill.log | awk '{print $3}' > failed-days.txt

# Retry each day
cat failed-days.txt | while read day; do
  npx tsx scripts/backfill-energy-flow-matrix.ts \
    --start $day \
    --end $day \
    --force
done
```

### Progress Tracking

The script logs:

```
Processing system 10000 (Kinkora Unified)...
  Date range: 2025-01-01 to 2025-11-13
  317 days to process
  Processing batch 1/11 (30 days)...
    ✓ 2025-01-01: 18 flows
    ✓ 2025-01-02: 19 flows
    ...
  Processing batch 2/11 (30 days)...
    ...

=== Backfill Complete ===
Systems: 1/1 processed, 0 failed
Days: 317/317 processed, 0 failed, 0 skipped
```

### Optimization Tips

1. **Larger batches**: Use `--batch-size 90` for faster processing (more memory)
2. **Parallel systems**: Run multiple systems simultaneously
3. **Off-peak hours**: Schedule during low-traffic periods
4. **Database tuning**: Ensure indexes are built before large backfills
5. **Connection pooling**: Use database connection pool for parallel runs

---

## Client Integration

### API Endpoint

**Location**: `/app/api/energy-flow-matrix/route.ts`

```typescript
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const systemId = searchParams.get("systemId");
  const period = searchParams.get("period"); // "1D", "7D", "30D"

  // For 30D, use server-side matrix data
  if (period === "30D") {
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 30);

    const matrix = await queryAndAggregateMatrix(
      systemId,
      startDate.toISOString().split("T")[0],
      endDate.toISOString().split("T")[0],
    );

    return NextResponse.json(matrix);
  }

  // For 1D/7D, return null to trigger client-side calculation
  return NextResponse.json(null);
}

async function queryAndAggregateMatrix(
  systemId: string,
  startDate: string,
  endDate: string,
) {
  // Query flows with labels
  const flows = await queryEnergyFlowMatrix(systemId, startDate, endDate);

  // Aggregate by source/load path
  const aggregated = new Map<string, number>();

  for (const flow of flows) {
    const key = `${flow.sourcePath}→${flow.loadPath}`;
    aggregated.set(key, (aggregated.get(key) || 0) + flow.energyKwh);
  }

  // Build matrix in format expected by client
  const sources = [...new Set(flows.map((f) => f.sourcePath))];
  const loads = [...new Set(flows.map((f) => f.loadPath))];

  return {
    sources: sources.map((path) => ({
      id: path,
      label: flows.find((f) => f.sourcePath === path)!.sourceLabel,
    })),
    loads: loads.map((path) => ({
      id: path,
      label: flows.find((f) => f.loadPath === path)!.loadLabel,
    })),
    flows: sources.map((source) =>
      loads.map((load) => aggregated.get(`${source}→${load}`) || 0),
    ),
    sourceTotals: sources.map((source) =>
      loads.reduce(
        (sum, load) => sum + (aggregated.get(`${source}→${load}`) || 0),
        0,
      ),
    ),
    loadTotals: loads.map((load) =>
      sources.reduce(
        (sum, source) => sum + (aggregated.get(`${source}→${load}`) || 0),
        0,
      ),
    ),
  };
}
```

### Client Usage

**File**: `lib/site-data-processor.ts` or dashboard component

```typescript
// Existing client-side calculation for 1D/7D
const clientMatrix = calculateEnergyFlowMatrix({
  generation: processedHistoryData.generation,
  load: processedHistoryData.load,
});

// For 30D, fetch server-side matrix
const serverMatrix =
  period === "30D"
    ? await fetch(
        `/api/energy-flow-matrix?systemId=${systemId}&period=30D`,
      ).then((r) => r.json())
    : null;

// Use server matrix if available, otherwise use client matrix
const matrix = serverMatrix || clientMatrix;
```

### Fallback Behavior

1. **Server data available**: Use pre-calculated matrix (30D)
2. **Server data missing**: Fall back to client-side calculation with warning
3. **Error fetching**: Use client-side calculation, log error
4. **1D/7D periods**: Always use client-side calculation (no fallback needed)

---

## Migration Path

### Phase 1: Database Setup (1-2 hours)

**Tasks:**

1. Create migration file: `migrations/NNNN_add_energy_flow_matrix_1d.sql`
2. Run migration on development database
3. Verify schema with test queries
4. Deploy migration to production

**Validation:**

- Table exists with correct schema
- Indexes are created
- Foreign keys work correctly
- Can insert/query test data

### Phase 2: Cron Job Implementation (2-3 hours)

**Tasks:**

1. Implement `lib/energy-flow-matrix-daily.ts` calculation logic
2. Create cron endpoint: `app/api/cron/daily-energy-matrix/route.ts`
3. Test with single system, single day
4. Configure Vercel cron schedule
5. Deploy and verify first run

**Validation:**

- Cron job runs successfully at 00:05
- All systems processed without errors
- Matrix data appears in database
- Query performance is acceptable

### Phase 3: Backfill Historical Data (4-12 hours depending on data volume)

**Tasks:**

1. Create backfill script: `scripts/backfill-energy-flow-matrix.ts`
2. Test on single system, recent date range
3. Run full backfill (choose strategy based on scale)
4. Verify data accuracy by spot-checking known periods
5. Monitor and handle any errors

**Validation:**

- All historical days have matrix data
- Spot checks match expected values
- No systematic errors or missing data
- Database size within expected range

### Phase 4: Client Integration (2-3 hours)

**Tasks:**

1. Create API endpoint: `app/api/energy-flow-matrix/route.ts`
2. Update dashboard to use server-side matrix for 30D
3. Keep client-side calculation for 1D/7D
4. Add fallback for missing server data
5. Test all period views

**Validation:**

- 30D view uses server-side data
- 1D/7D views use client-side calculation
- Energy values are accurate in 30D
- Sankey diagram updates correctly
- EnergyTable shows correct totals

### Phase 5: Remove Warning (0.5 hours)

**Tasks:**

1. Remove amber warning from DashboardClient.tsx
2. Update energy-calculator.ts documentation
3. Deploy changes

**Validation:**

- Warning no longer appears in 30D view
- Users see accurate values
- No client-side errors

### Phase 6 (Future): Split Bidirectional at Recording

**Optional future enhancement** (see earlier analysis):

- Modify push endpoints to split battery/grid at recording time
- Eliminates need for splitting logic in matrix calculation
- Provides consistent power/energy metric handling
- Requires vendor adapter updates and data migration

---

## Testing & Validation

### Test Cases

#### 1. Single System, Single Day

```bash
# Calculate matrix for known day
npx tsx scripts/backfill-energy-flow-matrix.ts \
  --system 10000 \
  --start 2025-11-13 \
  --end 2025-11-13 \
  --force

# Verify results
sqlite3 dev.db "
SELECT source_path, load_path, ROUND(energy_kwh, 2) as energy
FROM energy_flow_matrix_1d
WHERE system_id = '10000' AND day = '2025-11-13'
ORDER BY energy DESC
LIMIT 10;
"
```

**Expected:** Flows match known energy patterns for that day

#### 2. Compare Server vs. Client Calculation

```typescript
// Test script: scripts/test-matrix-comparison.ts

async function compareMatrices(systemId: string, day: string) {
  // Calculate server-side matrix
  const serverMatrix = await calculateDailyEnergyMatrix(systemId, day);

  // Fetch same data and calculate client-side
  const historyData = await fetchHistoryData(systemId, day, "1D");
  const clientMatrix = calculateEnergyFlowMatrix(historyData);

  // Compare totals
  console.log("Server source totals:", serverMatrix.sourceTotals);
  console.log("Client source totals:", clientMatrix.sourceTotals);
  console.log("Server load totals:", serverMatrix.loadTotals);
  console.log("Client load totals:", clientMatrix.loadTotals);

  // Check differences
  const sourceDiff = serverMatrix.sourceTotals.map((s, i) =>
    Math.abs(s - clientMatrix.sourceTotals[i]),
  );
  const maxDiff = Math.max(...sourceDiff);

  if (maxDiff > 0.1) {
    // Allow 100 Wh tolerance
    console.error("❌ Matrices differ by more than tolerance");
  } else {
    console.log("✅ Matrices match within tolerance");
  }
}
```

**Expected:** Server and client calculations match within rounding tolerance

#### 3. Synthetic Series Validation

Verify rest of house calculation:

```sql
-- For a given day, verify rest of house = generation - known loads
SELECT
  day,
  (SELECT SUM(energy_kwh) FROM energy_flow_matrix_1d
   WHERE day = m.day AND source_path LIKE 'source.%') as total_generation,
  (SELECT SUM(energy_kwh) FROM energy_flow_matrix_1d
   WHERE day = m.day AND load_path NOT IN ('load.rest_of_house')) as known_loads,
  (SELECT energy_kwh FROM energy_flow_matrix_1d
   WHERE day = m.day AND load_path = 'load.rest_of_house') as rest_of_house,
  (total_generation - known_loads - rest_of_house) as difference
FROM energy_flow_matrix_1d m
WHERE system_id = '10000' AND day = '2025-11-13'
LIMIT 1;
```

**Expected:** Difference ≈ 0 (within rounding)

#### 4. Point Reference Integrity

Verify all point references are valid:

```sql
-- Check for broken point references
SELECT
  m.system_id,
  m.day,
  m.source_path,
  m.source_point_system_id,
  m.source_point_index
FROM energy_flow_matrix_1d m
WHERE m.source_point_system_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM points p
    WHERE p.system_id = m.source_point_system_id
      AND p.index = m.source_point_index
  )
LIMIT 10;
```

**Expected:** No results (all references valid)

#### 5. Performance Benchmarks

```typescript
// Measure query performance
console.time("30D Query");
const matrix = await queryAndAggregateMatrix(
  "10000",
  "2025-10-15",
  "2025-11-13",
);
console.timeEnd("30D Query");
```

**Expected:**

- Query time < 100ms for 30 days
- Faster than client-side calculation (~5s)

### Validation Checklist

- [ ] Table schema matches specification
- [ ] Indexes improve query performance
- [ ] Foreign key constraints prevent invalid references
- [ ] Cron job runs successfully every day
- [ ] All systems processed without errors
- [ ] Backfill completes for all historical data
- [ ] Server matrix matches client matrix calculations
- [ ] Rest of house values are reasonable
- [ ] Split bidirectional series have correct point references
- [ ] Labels update when points are renamed
- [ ] 30D view shows accurate energy values
- [ ] Warning message removed
- [ ] No performance degradation

---

## Storage Estimates

### Per System Per Day

**Typical system** (2 sources, 5 loads):

- Flows: 2 × 5 = 10 rows
- Row size: ~150 bytes
- Total: 10 × 150 = 1.5 KB/day

**Complex system** (4 sources, 10 loads):

- Flows: 4 × 10 = 40 rows
- Row size: ~150 bytes
- Total: 40 × 150 = 6 KB/day

### Annual Storage

| Systems | Flows/Day | Storage/Year |
| ------- | --------- | ------------ |
| 1       | 10        | 550 KB       |
| 10      | 10 each   | 5.5 MB       |
| 100     | 10 each   | 55 MB        |
| 1000    | 10 each   | 550 MB       |

**Conclusion:** Storage requirements are minimal compared to point readings.

---

## Future Enhancements

### 1. Split Bidirectional at Recording Time

Move the bidirectional splitting upstream to point recording:

- Record `bidi.battery.charge` and `bidi.battery.discharge` as separate points
- Eliminate splitting logic in matrix calculation
- Make power metrics consistent with energy metrics
- Requires vendor adapter changes and data migration

**Benefits:**

- Simpler matrix calculation
- Consistent data model
- Better aggregation semantics
- Enables accurate 30D calculations from point aggregates

### 2. Real-Time Matrix Updates

Calculate matrix in real-time as 5-minute aggregates are created:

- Update running daily totals throughout the day
- Provide live energy flow visualization
- Finalize at end of day

### 3. Hourly Aggregation

Add `energy_flow_matrix_1h` table for higher resolution:

- Enables accurate weekly views
- Better granularity for analysis
- Hourly trends and patterns

### 4. Composite System Flows

Track cross-system energy flows explicitly:

- Solar from child → Load in parent
- Battery in parent → Load in child
- Enables detailed composite system analysis

---

## References

- **Current Implementation**: `lib/energy-flow-matrix.ts` - Client-side matrix calculation
- **Energy Calculator**: `lib/energy-calculator.ts` - Trapezoidal integration logic
- **Site Processor**: `lib/site-data-processor.ts` - Battery splitting and rest of house
- **Point Aggregation**: `lib/db/aggregate-daily-points.ts` - Daily point aggregation
- **Database Schema**: `lib/db/schema-monitoring-points.ts` - Point tables definition
- **Sankey Visualization**: `components/EnergyFlowSankey.tsx` - Flow diagram component

---

## Questions & Decisions

### Resolved

- ✅ **Store labels?** No - derive from points table at query time
- ✅ **Composite system support?** Yes - use system_id + index for point references
- ✅ **Synthetic series handling?** NULL point references, generate labels from path
- ✅ **Split at recording vs. calculation?** Split at calculation (recording is future enhancement)

### Open

- ⏳ **Retention policy?** Keep all historical data or archive after X years?
- ⏳ **Reprocessing strategy?** When/how to regenerate matrix data if logic changes?
- ⏳ **Monitoring/alerting?** What metrics to track, when to alert?

---

## Appendix A: Example Queries

### Query Total Energy by Source

```sql
SELECT
  m.source_path,
  p.name as point_name,
  SUM(m.energy_kwh) as total_kwh
FROM energy_flow_matrix_1d m
LEFT JOIN points p ON
  p.system_id = m.source_point_system_id AND
  p.index = m.source_point_index
WHERE m.system_id = '10000'
  AND m.day >= '2025-10-01'
  AND m.day <= '2025-10-31'
GROUP BY m.source_path
ORDER BY total_kwh DESC;
```

### Query Energy Flow Between Specific Source and Load

```sql
SELECT
  day,
  energy_kwh,
  sample_count
FROM energy_flow_matrix_1d
WHERE system_id = '10000'
  AND source_path = 'source.solar.local'
  AND load_path = 'load.hws'
  AND day >= '2025-11-01'
  AND day <= '2025-11-13'
ORDER BY day;
```

### Query Top Energy Flows for a Day

```sql
SELECT
  source_path,
  load_path,
  energy_kwh,
  ROUND(energy_kwh / (SELECT SUM(energy_kwh) FROM energy_flow_matrix_1d
        WHERE system_id = '10000' AND day = '2025-11-13') * 100, 1) as percent
FROM energy_flow_matrix_1d
WHERE system_id = '10000'
  AND day = '2025-11-13'
ORDER BY energy_kwh DESC
LIMIT 10;
```

### Find Days with Incomplete Data

```sql
SELECT
  day,
  COUNT(*) as flow_count,
  MAX(sample_count) as max_samples
FROM energy_flow_matrix_1d
WHERE system_id = '10000'
  AND day >= '2025-11-01'
GROUP BY day
HAVING max_samples < 288  -- Less than 24h × 12 intervals
ORDER BY day;
```

---

## Appendix B: Migration SQL

**File**: `migrations/NNNN_add_energy_flow_matrix_1d.sql`

```sql
-- Migration: Add energy_flow_matrix_1d table for daily energy flow calculations

CREATE TABLE energy_flow_matrix_1d (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id TEXT NOT NULL,
    day TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    source_path TEXT NOT NULL,
    source_point_system_id TEXT,
    source_point_index INTEGER,

    load_path TEXT NOT NULL,
    load_point_system_id TEXT,
    load_point_index INTEGER,

    energy_kwh REAL NOT NULL,
    sample_count INTEGER,
    version INTEGER DEFAULT 1,

    FOREIGN KEY (system_id) REFERENCES systems (id),
    FOREIGN KEY (source_point_system_id, source_point_index)
        REFERENCES points (system_id, index),
    FOREIGN KEY (load_point_system_id, load_point_index)
        REFERENCES points (system_id, index)
);

CREATE UNIQUE INDEX idx_energy_flow_matrix_1d_unique
    ON energy_flow_matrix_1d(system_id, day, source_path, load_path);

CREATE INDEX idx_energy_flow_matrix_1d_system_day
    ON energy_flow_matrix_1d(system_id, day);

CREATE INDEX idx_energy_flow_matrix_1d_day
    ON energy_flow_matrix_1d(day);

CREATE INDEX idx_energy_flow_matrix_1d_source_point
    ON energy_flow_matrix_1d(source_point_system_id, source_point_index)
    WHERE source_point_system_id IS NOT NULL;

CREATE INDEX idx_energy_flow_matrix_1d_load_point
    ON energy_flow_matrix_1d(load_point_system_id, load_point_index)
    WHERE load_point_system_id IS NOT NULL;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('NNNN_add_energy_flow_matrix_1d');
```
