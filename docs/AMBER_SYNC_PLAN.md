# Implementation Plan: Amber Client with Audit-Based Syncing

## Overview

The `/lib/vendors/amber/client.ts` implements methodical, audit-focused syncing with auto-numbered stages. This will eventually replace the current adapter.ts polling mechanism.

**Status**: Phase 1 complete - read-only audit operations implemented for both usage and forecasts

## File Structure

**Main file**: `/lib/vendors/amber/client.ts`

- Two main entry points: `updateUsage()` and `updateForecasts()`
- Core sync logic with auto-numbered stages
- Read-only audit operations
- Returns detailed audit objects tracking what happened

**Helper file**: `/lib/vendors/amber/point-reading-group.ts`

- `PointReadingGroup` class - encapsulates a day's worth of point readings
- Organized by time interval and point key
- Provides overview strings, completeness analysis, and characterisation
- Validates readings are within day boundaries

**Type definitions**: `/lib/vendors/amber/types.ts`

- Audit results, stage results, and characterisation types
- Branded Milliseconds type for type safety
- AmberCredentials, AmberSite, AmberUsageRecord, AmberPriceRecord types

## Key Types

```typescript
// Branded type for millisecond timestamps
export type Milliseconds = number & { readonly __brand: "Milliseconds" };

// Completeness states
export type Completeness = "all-billable" | "none" | "mixed";

// Result from a single sync stage
export interface StageResult {
  stage: string; // e.g., "stage 1: load local usage"
  completeness: Completeness;
  overviews: Map<string, string>; // Map of point origin ID to overview (48 chars each)
  numRecords: number; // Count of non-null records (required for all stages)
  characterisation?: CharacterisationRange[];
  records?: Map<string, Map<string, PointReading>>;
  error?: string;
  request?: string; // Debug info about the API request made
  discovery?: string; // Optional text description of what was discovered/learned
}

// Quality range grouping for mixed completeness
export interface CharacterisationRange {
  rangeStartTimeMs: Milliseconds;
  rangeEndTimeMs: Milliseconds;
  quality: string | null;
  pointOriginIds: string[]; // e.g., ["E1.kwh", "B1.cost"] - varies by site
}

// Point reading structure for sync records
export interface PointReading {
  pointMetadata: PointMetadata;
  rawValue: any;
  measurementTimeMs: Milliseconds;
  receivedTimeMs: Milliseconds;
  dataQuality?: string;
  sessionId: number;
  error?: string | null;
}

// Complete sync audit result
export interface SyncAudit {
  systemId: number;
  day: CalendarDate;
  stages: StageResult[];
  summary: {
    totalStages: number;
    durationMs: Milliseconds;
    error?: string;
    exception?: Error;
  };
}
```

## Implementation Stages

Both `updateUsage` and `updateForecasts` follow a similar 3-stage pattern:

### Stage 1: Load Local Data

**Input**: systemId, day

**Process**:

1. Create `PointReadingGroup` for the day
2. Query local database for all point readings in the day's 48 intervals
3. Add each reading to the group (validates boundaries)
4. Get overview, completeness, and characterisation from the group

**Output**: StageResult with overviews (one per point), completeness, numRecords, characterisation?, records

### Stage 2: Load Remote Data

**Input**: credentials, day

**Process**:

1. Create `PointReadingGroup` for the day
2. Format date as YYYY-MM-DD string
3. Call Amber API:
   - Usage: `GET /v1/sites/{siteId}/usage?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
   - Prices: `GET /v1/sites/{siteId}/prices?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
4. Parse API response (typically 48 × N channel records)
5. Create point readings with appropriate point metadata
6. Add each reading to the group (validates boundaries)
7. Get overview, completeness, and characterisation from the group

**Output**: StageResult with overviews, completeness, numRecords, characterisation?, records, request info

**Critical for prices**: Use `record.nemTime` (AEST) NOT `record.endTime` (UTC)

### Stage 3: Compare and Identify Superior Records

**Input**: Stage 1 result, Stage 2 result

**Process**:

1. If either previous stage has error, return early with error
2. For each point key found in either local or remote:
   - For each of 48 intervals:
     - Compare quality levels using precedence order
     - If remote quality is SUPERIOR: mark for update/insert
3. Build comparison overviews showing which intervals need updating
4. Collect all superior records for potential future database write
5. Return numRecords = count of superior records found

**Output**: StageResult with comparison analysis, superior records identified

**Quality Precedence**:

- Usage: billable > actual > estimated > null
- Prices: actual > forecast > null

**Comparison Overview Format**:

- Lowercase letter (b, a, e, f, .) = local quality (remote not superior)
- Uppercase letter (B, A, E, F) = remote quality is superior

**Examples**:

- Local: `bbbbbbbb`, Remote: `bbbbbbbb` → Comparison: `bbbbbbbb` (no changes)
- Local: `bbbbeeee`, Remote: `bbbbbbbb` → Comparison: `BBBBeeee` (first 4 upgraded)
- Local: `....bbbb`, Remote: `aaaabbbb` → Comparison: `AAAAbbbb` (first 4 added)

## Helper Functions

### Auto-stage numbering

```typescript
class StageTracker {
  private currentStage = 0;

  nextStage(description: string): string {
    this.currentStage++;
    return `stage ${this.currentStage}: ${description}`;
  }
}
```

### Quality abbreviation

```typescript
function abbreviateQuality(quality: string | null): string {
  if (quality === null) return ".";
  return quality.charAt(0).toLowerCase();
}
```

**Note**: No quality mapping - use raw values from API. Just abbreviate to first letter lowercase.

### Quality precedence comparison

```typescript
const QUALITY_PRECEDENCE: Record<string, number> = {
  billable: 4,
  actual: 3,
  estimated: 2,
  forecast: 1,
};

function getQualityPrecedence(quality: string | null): number {
  if (quality === null) return 0;
  return QUALITY_PRECEDENCE[quality] ?? 0;
}

function isRemoteQualitySuperior(
  localQuality: string | null,
  remoteQuality: string | null,
  localMeasurementTime?: Milliseconds,
  remoteMeasurementTime?: Milliseconds,
): boolean {
  const localPrecedence = getQualityPrecedence(localQuality);
  const remotePrecedence = getQualityPrecedence(remoteQuality);

  if (remotePrecedence > localPrecedence) return true;
  if (remotePrecedence < localPrecedence) return false;

  // Same quality - check measurement time if available
  if (localMeasurementTime && remoteMeasurementTime) {
    return remoteMeasurementTime > localMeasurementTime;
  }

  return false;
}
```

### Completeness determination

```typescript
function determineCompleteness(overview: string): Completeness {
  if (overview.length !== 48) {
    throw new Error(`Invalid overview length: ${overview.length}, expected 48`);
  }

  const nonNull = overview.replace(/\./g, "").length;
  const billable = overview.replace(/[^b]/g, "").length;

  if (billable === 48) return "all-billable";
  if (nonNull === 0) return "none";
  return "mixed";
}
```

### AEST time generation

**Important**: Amber uses fixed UTC+10 (AEST), NOT Australia/Sydney timezone which observes DST.

```typescript
import { toCalendarDateTime, toZoned } from "@internationalized/date";

function generate48IntervalsAEST(day: CalendarDate): Milliseconds[] {
  const intervals: Milliseconds[] = [];

  // Convert CalendarDate to ZonedDateTime at midnight in +10:00 timezone (AEST)
  let current = toZoned(toCalendarDateTime(day), "+10:00");

  // Generate 48 intervals starting at 00:30 AEST
  for (let i = 0; i < 48; i++) {
    current = current.add({ minutes: 30 });
    intervals.push(current.toDate().getTime() as Milliseconds);
  }

  return intervals;
}
```

**Critical**: Use `ZonedDateTime` from `@internationalized/date` library with fixed "+10:00" offset. Do NOT use manual date arithmetic or native Date object timezone handling.

## Main Entry Points

There are two separate sync functions, one for usage and one for forecasts:

### updateUsage

```typescript
export async function updateUsage(
  systemId: number,
  day: CalendarDate,
  credentials: AmberCredentials,
): Promise<SyncAudit> {
  // Stage 1: Load local usage
  // Stage 2: Load remote usage from /v1/sites/{siteId}/usage API
  // Stage 3: Compare and identify superior records
  return audit;
}
```

**Key points**:

- Uses Amber `/usage` endpoint which returns actual/billable energy consumption
- Creates point readings for E1.kwh, E1.cost, B1.kwh, B1.cost (per-channel metrics)
- Quality levels: billable > actual > estimated > null

### updateForecasts

```typescript
export async function updateForecasts(
  systemId: number,
  day: CalendarDate,
  credentials: AmberCredentials,
): Promise<SyncAudit> {
  // Stage 1: Load local forecasts
  // Stage 2: Load remote prices from /v1/sites/{siteId}/prices API
  // Stage 3: Compare and identify superior records
  return audit;
}
```

**Key points**:

- Uses Amber `/prices` endpoint which returns pricing forecasts
- Creates point readings for:
  - **Per-channel**: E1.perKwh, B1.perKwh (channel-specific pricing)
  - **Grid-level**: grid.spotPerKwh (wholesale spot price), grid.renewables (renewable percentage)
- Quality levels: actual > forecast > null
- **Critical**: Parse `record.nemTime` (AEST) NOT `record.endTime` (UTC) for timestamps

### Price Point Key Mapping

**Do NOT use generic "rate" or "pct" subIds**. Use actual field names:

| API Field    | Point Key                  | Level       | Description                                        |
| ------------ | -------------------------- | ----------- | -------------------------------------------------- |
| `perKwh`     | `E1.perKwh` or `B1.perKwh` | Per-channel | Final price including wholesale + network + margin |
| `spotPerKwh` | `grid.spotPerKwh`          | Grid-level  | Wholesale spot market price component              |
| `renewables` | `grid.renewables`          | Grid-level  | Renewable energy percentage (0-100)                |

## Database Integration

### Use PointManager (not direct queries)

```typescript
import { PointManager } from "@/lib/monitoring-points-manager";

const pointManager = new PointManager(systemId);
await pointManager.initialize();
const allPoints = pointManager.getAllPoints();
```

### Use History API for fetching readings

```typescript
import { fetchDailyAggregates5m } from "@/lib/history/...";

const pointIds = allPoints.map((p) => p.index);
const readings = await fetchDailyAggregates5m(
  systemId,
  day,
  pointIds,
  expectedIntervals,
);
```

## Quality Indicators

Based on production data analysis:

| Abbreviation | Meaning   | Count in Production |
| ------------ | --------- | ------------------- |
| `b`          | billable  | 1008 records (64%)  |
| `a`          | actual    | 243 records (15%)   |
| `f`          | forecast  | 237 records (15%)   |
| `e`          | estimated | 0 records           |
| `.`          | null      | 96 records (6%)     |
| `?`          | unknown   | For unrecognized    |

**Note**: Production data shows no "estimated" quality. Amber appears to skip straight to "billable" for usage data.

## Overview String Format

48 characters representing 48 half-hour intervals from 00:30 AEST to 00:00 AEST (next day):

```
Position 0:  00:30 AEST
Position 1:  01:00 AEST
Position 2:  01:30 AEST
...
Position 46: 23:30 AEST
Position 47: 00:00 AEST (next day)
```

### Examples

**All billable**:

```
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

**None**:

```
................................................
```

**Mixed**:

```
bbbbaaaaffffffff........aaaaaaaaaaaabbbbbbbbbbbb
```

## Characterisation Structure

When completeness is "mixed", group consecutive intervals with same quality:

```typescript
// Example for overview: "bbbbaaaaffffffff........"
[
  {
    rangeStartTimeMs: 1737129000000, // 00:30 AEST
    rangeEndTimeMs: 1737136200000, // 02:30 AEST
    quality: "billable",
    pointOriginIds: ["E1.kwh", "B1.kwh"],
  },
  {
    rangeStartTimeMs: 1737136200000, // 02:30 AEST
    rangeEndTimeMs: 1737145200000, // 05:00 AEST
    quality: "actual",
    pointOriginIds: ["E1.kwh", "B1.kwh"],
  },
  {
    rangeStartTimeMs: 1737145200000, // 05:00 AEST
    rangeEndTimeMs: 1737152400000, // 07:00 AEST
    quality: "forecast",
    pointOriginIds: ["E1.kwh", "B1.kwh"],
  },
  {
    rangeStartTimeMs: 1737152400000, // 07:00 AEST
    rangeEndTimeMs: 1737172800000, // 12:40 AEST
    quality: null,
    pointOriginIds: [],
  },
];
```

## Records Structure

```typescript
// Map of timestamp -> Map of point key -> reading
Map<string, Map<string, PointReading>>

// Note: Records include ALL points at each timestamp (not just E1.kwh)
// Example:
{
  "2025-01-18 00:30": {
    "E1.kwh": {
      pointMetadata: {...},
      rawValue: 1250,
      measurementTimeMs: 1737129000000,
      receivedTimeMs: 1737129123456,
      dataQuality: "billable",
      sessionId: 42,
    },
    "E1.cost": {
      pointMetadata: {...},
      rawValue: 165,
      measurementTimeMs: 1737129000000,
      receivedTimeMs: 1737129123456,
      dataQuality: "billable",
      sessionId: 42,
    },
    "B1.kwh": {...},
    "B1.cost": {...},
    // etc.
  },
  "2025-01-18 01:00": {
    "E1.kwh": {...},
    "E1.cost": {...},
    // etc.
  },
  // ... 46 more intervals
}
```

## Testing

### Create test script: `/scripts/temp/test-amber-sync.ts`

```typescript
import { syncAmberDay } from "@/lib/vendors/amber/client";
import { parseDateISO } from "@/lib/date-utils";

async function testSync() {
  const systemId = 9; // Amber system ID
  const day = parseDateISO("2025-11-17"); // Recent day with data
  const credentials = {
    apiKey: process.env.AMBER_API_KEY!,
    siteId: process.env.AMBER_SITE_ID,
  };

  console.log(`Testing sync for ${day.toString()}...`);

  const audit = await syncAmberDay(systemId, day, credentials);

  console.log("\n=== SYNC AUDIT ===");
  console.log(`System ID: ${audit.systemId}`);
  console.log(`Day: ${audit.day.toString()}`);
  console.log(`Total stages: ${audit.summary.totalStages}`);
  console.log(`Duration: ${audit.summary.durationMs}ms`);

  if (audit.summary.error) {
    console.log(`ERROR: ${audit.summary.error}`);
  }

  if (audit.summary.exception) {
    console.log(`EXCEPTION:`, audit.summary.exception);
  }

  for (const stage of audit.stages) {
    console.log(`\n--- ${stage.stage} ---`);
    console.log(`Completeness: ${stage.completeness}`);
    console.log(`Overview: ${stage.overview}`);
    console.log(`Num Records: ${stage.numRecords}`);

    if (stage.characterisation) {
      console.log(
        `Characterisation (${stage.characterisation.length} ranges):`,
      );
      for (const range of stage.characterisation) {
        console.log(
          `  ${new Date(range.rangeStartTimeMs).toISOString()} - ${new Date(range.rangeEndTimeMs).toISOString()}: ${range.quality}`,
        );
      }
    }

    if (stage.error) {
      console.log(`ERROR:`, stage.error);
    }
  }
}

testSync().catch(console.error);
```

### Running the test script:

```bash
# Test usage sync for a specific date
npx tsx scripts/temp/test-amber-sync.ts 2025-11-19 usage

# Test forecasts sync for a specific date
npx tsx scripts/temp/test-amber-sync.ts 2025-11-19 forecasts

# Test both usage and forecasts
npx tsx scripts/temp/test-amber-sync.ts 2025-11-19 both

# Default: tests usage for 2025-11-17
npx tsx scripts/temp/test-amber-sync.ts
```

### Test scenarios:

1. **Recent day with billable data**: `npx tsx scripts/temp/test-amber-sync.ts 2025-11-17 usage`
2. **Today (may have actual/forecast data)**: `npx tsx scripts/temp/test-amber-sync.ts 2025-11-19 forecasts`
3. **Future day (should have no data)**: `npx tsx scripts/temp/test-amber-sync.ts 2025-12-31 usage`

## Success Criteria

- ✅ Branded millisecond types for type safety
- ✅ Separate `updateUsage()` and `updateForecasts()` functions
- ✅ `PointReadingGroup` class encapsulates day's readings with validation
- ✅ Boundary validation throws exceptions for out-of-bounds readings
- ✅ Throws error if overview.length !== 48
- ✅ numRecords required on all stages (0 if none)
- ✅ All stages stop on error (no cascading failures)
- ✅ Fetch and validate ALL points, not just import energy
- ✅ Multi-series overviews (Map of point key → 48-char overview)
- ✅ Quality abbreviation uses first letter lowercase
- ✅ No quality mapping - use raw values from API
- ✅ Comparison uses quality precedence correctly
- ✅ Comparison overview: lowercase = local, UPPERCASE = remote superior
- ✅ pointOriginIds instead of points in CharacterisationRange
- ✅ Records include all points at each timestamp
- ✅ Single return point with conditional error/exception
- ✅ All timestamps in AEST using ZonedDateTime with fixed "+10:00" offset
- ✅ Price timestamps parse nemTime (AEST) NOT endTime (UTC)
- ✅ Correct price point keys: E1.perKwh, B1.perKwh, grid.spotPerKwh, grid.renewables
- ✅ Handles missing data gracefully
- ✅ Handles API errors gracefully
- ✅ Comparison stage accurately identifies differences

## Future Extensions

### Phase 2: Bulk Insert/Update

- Stage 2: Insert or update records in database
- Use superior records identified in comparison stage
- Bulk insert operations for efficiency
- Update session tracking

### Additional Features

- Price forecast syncing and validation
- Historical data backfill
- Quality upgrade detection (estimated → billable)
- Automated sync scheduling

## Important Implementation Notes

### Timezone Handling

- **All times are in AEST (fixed UTC+10)** - NOT Australia/Sydney which observes DST
- Use `@internationalized/date` library's `ZonedDateTime` with "+10:00" offset
- **Critical**: Use `.add({ minutes: 30 })` for date arithmetic, NOT manual millisecond math
- Database stores timestamps as Unix milliseconds (UTC internally)
- Amber API returns:
  - `endTime`: ISO 8601 UTC string
  - `nemTime`: ISO 8601 AEST string (**use this for price timestamps**)
- Exactly 48 half-hour intervals per day (00:30 AEST to 00:00 AEST next day)

### Price Point Keys

- **Do NOT use generic "rate" or "pct"** - use actual API field names as subIds
- Per-channel prices: `E1.perKwh`, `B1.perKwh`
- Grid-level metrics: `grid.spotPerKwh`, `grid.renewables`
- Helper functions: `createAmberPointMetadata()` for channel-level, `createGridPointMetadata()` for grid-level

### PointReadingGroup Class

- Validates all readings are within day boundaries (throws exception if not)
- Pre-populates all 48 interval slots
- Provides methods: `add()`, `get()`, `getOverviews()`, `getCompleteness()`, `getCharacterisation()`
- Returns Map-based structures (not arrays) for efficient lookup

### Quality Levels

- Usage data: billable (64%), actual (15%), forecast (15%), null (6%)
- Price data: actual > forecast > null
- No "estimated" quality seen in production Amber data
- Use raw quality strings from API - no mapping needed

### Current Status

- Phase 1 complete: read-only audit operations
- Both `updateUsage()` and `updateForecasts()` implemented
- Comprehensive error handling at every stage
- Detailed audit trail for debugging and monitoring
- Next: Phase 2 will add database write operations
