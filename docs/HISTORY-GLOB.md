# History API Glob Pattern Filtering

## Overview

This document describes glob pattern-based series filtering in the history API to improve performance by fetching only the series that charts actually need, rather than fetching all series and filtering client-side or server-side.

## Current State Analysis

### Current Behavior

**EnergyChart:**

- Uses `matchLegacy=true` parameter
- Fetches: 20 series from database (all available)
- Uses: 5-6 series (filtered server-side via hardcoded patterns)
- Waste: ~75% of fetched data unused

**MondoChart:**

- No filtering parameter
- Fetches: 20 series from database (all available)
- Uses: 4-12 series depending on mode (filtered client-side)
- Waste: 40-80% of fetched data unused

### Performance Metrics (24h of 5m data)

| Metric          | Current  | With Regex Filter |
| --------------- | -------- | ----------------- |
| Database rows   | 5,760    | 288-1,440         |
| Query time      | 50-100ms | 10-20ms           |
| Data transfer   | 46 KB    | 2-12 KB           |
| Series returned | 20       | 1-5               |

**Performance gain: 5-10x faster queries, 4-20x smaller transfers**

## Series Usage by Chart

### EnergyChart Component

Location: `components/EnergyChart.tsx`

#### 5-Minute and 30-Minute Intervals (Power Mode)

| Series ID Pattern        | Purpose                          | Field          |
| ------------------------ | -------------------------------- | -------------- |
| `source.solar.power.avg` | Solar generation power           | solarData      |
| `load.power.avg`         | Total load power                 | loadData       |
| `bidi.battery.power.avg` | Battery power (charge/discharge) | batteryWData   |
| `bidi.battery.soc.last`  | Battery state of charge          | batterySOCData |
| `bidi.grid.power.avg`    | Grid power (import/export)       | gridData       |

**Example series IDs:**

```
liveone.system.3.source.solar.power.avg
liveone.system.3.load.power.avg
liveone.system.3.bidi.battery.power.avg
liveone.system.3.bidi.battery.soc.last
liveone.system.3.bidi.grid.power.avg
```

#### Daily Interval (Energy Mode)

| Series ID Pattern           | Purpose                    | Field             |
| --------------------------- | -------------------------- | ----------------- |
| `source.solar.energy.delta` | Solar energy generated     | solarData         |
| `load.energy.delta`         | Total load energy consumed | loadData          |
| `bidi.battery.soc.avg`      | Average battery SOC        | batterySOCData    |
| `bidi.battery.soc.min`      | Minimum battery SOC        | batterySOCMinData |
| `bidi.battery.soc.max`      | Maximum battery SOC        | batterySOCMaxData |

**Example series IDs:**

```
liveone.system.3.source.solar.energy.delta
liveone.system.3.load.energy.delta
liveone.system.3.bidi.battery.soc.avg
liveone.system.3.bidi.battery.soc.min
liveone.system.3.bidi.battery.soc.max
```

### MondoChart Component

Location: `components/MondoPowerChart.tsx`

#### 5m/30m Intervals (Both Load and Generation Modes)

**Note:** MondoChart switches between Load and Generation modes in the UI, but uses a single API query that fetches all needed series. The mode determines how data is displayed (which series are shown, how positive/negative values are interpreted), but the query is the same.

| Series Pattern           | Used in Mode | Purpose              | Examples                                                           |
| ------------------------ | ------------ | -------------------- | ------------------------------------------------------------------ |
| `load.*`                 | Load         | Individual loads     | `load.power.avg`, `load.hvac.power.avg`, `load.pool.power.avg`     |
| `rest_of_house`          | Load         | Calculated remainder | (computed client-side from total - sub-meters)                     |
| `source.solar.*.power.*` | Generation   | Solar sub-components | `source.solar.local.power.avg`, `source.solar.remote.power.avg`    |
| `bidi.battery.power.*`   | Both         | Battery power        | `bidi.battery.power.avg` (charge in Load, discharge in Generation) |
| `bidi.grid.power.*`      | Both         | Grid power           | `bidi.grid.power.avg` (export in Load, import in Generation)       |

**Key insight:** Battery and grid series are split by sign (positive/negative) to show charge vs discharge, import vs export.

## Proposed Regex Patterns

### EnergyChart Patterns

#### For 5m/30m Intervals (Power Mode)

```regex
^(source\.solar|load|bidi\.(battery|grid))\.power\.avg$|^bidi\.battery\.soc\.last$
```

**Matches:**

- `source.solar.power.avg` ✅
- `load.power.avg` ✅
- `bidi.battery.power.avg` ✅
- `bidi.grid.power.avg` ✅
- `bidi.battery.soc.last` ✅

**Rejects:**

- `load.hvac.power.avg` ❌ (sub-meter)
- `source.solar.energy.delta` ❌ (energy, not power)
- `bidi.battery.soc.avg` ❌ (avg, not last)

#### For 1d Interval (Energy Mode)

```regex
^(source\.solar|load)\.energy\.delta$|^bidi\.battery\.soc\.(avg|min|max)$
```

**Matches:**

- `source.solar.energy.delta` ✅
- `load.energy.delta` ✅
- `bidi.battery.soc.avg` ✅
- `bidi.battery.soc.min` ✅
- `bidi.battery.soc.max` ✅

### MondoChart Patterns

#### For Both Load and Generation Modes (5m/30m)

**Note:** MondoChart switches between Load and Generation modes in the UI, but uses a single API query that fetches all needed series.

```regex
^load\.|^source\.solar\.\w+\.power\.|^bidi\.(battery|grid)\.power\.
```

**Matches:**

- `load.power.avg` ✅ (total load)
- `load.hvac.power.avg` ✅ (HVAC sub-meter)
- `load.pool.power.avg` ✅ (pool sub-meter)
- `source.solar.local.power.avg` ✅ (local solar)
- `source.solar.remote.power.avg` ✅ (remote solar)
- `source.solar.rooftop.power.avg` ✅ (any other solar sub-component)
- `bidi.battery.power.avg` ✅ (battery - used by both modes)
- `bidi.grid.power.avg` ✅ (grid - used by both modes)

**Rejects:**

- `source.solar.power.avg` ❌ (aggregated solar total - not needed)
- `load.energy.delta` ❌ (energy, not power)
- `bidi.battery.soc.*` ❌ (SOC not shown in MondoChart)

## API Design

### URL Parameter: `series`

The `series` parameter accepts comma-separated glob patterns:

```bash
# EnergyChart - Power mode (5m/30m)
GET /api/history?systemId=3&interval=5m&last=24h&series=source.solar/power.avg,load*/power.avg,bidi.battery/power.avg,bidi.battery/soc.last,bidi.grid/power.avg

# EnergyChart - Energy mode (1d)
GET /api/history?systemId=3&interval=1d&last=30d&series=source.solar/energy.delta,load*/energy.delta,bidi.battery/power.avg,bidi.battery/soc.{avg,min,max},bidi.grid/energy.delta

# MondoChart - Power mode
GET /api/history?systemId=3&interval=5m&last=24h&series=source.solar/power.avg,load*/power.avg,bidi.battery/power.avg,bidi.grid/power.avg

# Backward compatible - no series parameter fetches all
GET /api/history?systemId=3&interval=5m&last=24h
```

### Glob Pattern Syntax

Uses micromatch library for pattern matching:

- `*` - matches any characters (e.g., `load*` matches `load`, `load.hvac`, `load.pool`)
- `**` - matches any path segments (e.g., `**/power.avg`)
- `{a,b}` - matches either a or b (e.g., `{source.solar,solar}` matches both)
- `{a,b,c}` - matches any of a, b, or c (e.g., `soc.{avg,min,max}`)

### Behavior

1. **If `series` parameter provided:**
   - Parse comma-separated patterns
   - Validate patterns (check length limits)
   - Filter points before database query using micromatch
   - Only query database for matching points
   - Return only matching series (OR logic - matches ANY pattern)

2. **If `series` parameter NOT provided:**
   - Fetch all series (current behavior)
   - Backward compatible with existing clients

### Pattern Validation

**Security measures:**

- Limit pattern length (max 200 characters per pattern)
- Micromatch handles glob patterns safely (no regex injection)
- No special validation needed beyond length limits

## Implementation Todo List

### Phase 1: Backend Infrastructure (Core Functionality)

#### 1.1 Add Series Parameter to History API

**File:** `app/api/history/route.ts`

- [ ] Parse `series` parameter from query string (after line 853)
- [ ] Add regex validation function:
  ```typescript
  function validateSeriesPattern(pattern: string): {
    valid: boolean;
    error?: string;
  };
  ```
- [ ] Add error handling for invalid regex patterns (400 Bad Request)
- [ ] Pass `seriesPattern` to `getSystemHistoryInOpenNEMFormat()`
- [ ] Update function signature (line 340)

#### 1.2 Update History Service

**File:** `lib/history/history-service.ts`

- [ ] Add `seriesPattern?: string` parameter to `getHistoryInOpenNEMFormat()` (line 45)
- [ ] Pass pattern to provider methods
- [ ] Update JSDoc comments

#### 1.3 Update PointReadingsProvider

**File:** `lib/history/point-readings-provider.ts`

- [ ] Add `seriesPattern?: string` to `fetch5MinuteData()` signature (line 121)
- [ ] Add `seriesPattern?: string` to `fetchDailyData()` signature (line 222)
- [ ] Implement point filtering logic:
  ```typescript
  if (seriesPattern) {
    const regex = new RegExp(seriesPattern);
    filteredPoints = filteredPoints.filter((p) => {
      const pointId = this.generatePointId(p, interval);
      return regex.test(pointId);
    });
  }
  ```
- [ ] Add point filtering before database query (after line 135, 236)
- [ ] Build `WHERE point_id IN (...)` clause with filtered point IDs
- [ ] Add logging for filtered point count

#### 1.4 Update Type Definitions

**File:** `lib/history/types.ts`

- [ ] Add `seriesPattern?: string` to `HistoryDataProvider` interface method signatures

### Phase 2: Frontend Integration (MondoChart)

#### 2.1 Update MondoChart

**File:** `components/MondoPowerChart.tsx`

- [ ] Add series pattern constant (both modes use same query):
  ```typescript
  const MONDO_SERIES_PATTERN =
    "^load\\.|^source\\.solar\\.\\w+\\.power\\.|^bidi\\.(battery|grid)\\.power\\.";
  ```

  - Note: `\w+` matches any solar sub-component (local, remote, rooftop, etc.) but excludes the aggregated total
  - This pattern fetches all series needed for BOTH load and generation modes
- [ ] Add `series` parameter to API URL (line 657):
  ```typescript
  &series=${encodeURIComponent(MONDO_SERIES_PATTERN)}
  ```
- [ ] Remove client-side type filtering (line 680) - no longer needed
- [ ] Update comment explaining server-side filtering and that both modes share query

#### 2.2 Update EnergyChart

**File:** `components/EnergyChart.tsx`

**Decision:** Use Option B - Switch to `series` parameter for consistency

- [ ] Create series pattern constants for both intervals:
  ```typescript
  const ENERGY_CHART_5M_PATTERN =
    "^(source\\.solar|load|bidi\\.(battery|grid))\\.power\\.avg$|^bidi\\.battery\\.soc\\.last$";
  const ENERGY_CHART_1D_PATTERN =
    "^(source\\.solar|load)\\.energy\\.delta$|^bidi\\.battery\\.soc\\.(avg|min|max)$";
  ```
- [ ] Build pattern based on interval (5m/30m uses same pattern)
- [ ] Replace `matchLegacy=true` with `series=${encodeURIComponent(pattern)}`
- [ ] Remove any fallback to legacy patterns
- [ ] Update comments to explain series filtering

### Phase 3: Testing & Validation

#### 3.1 Unit Tests

**File:** `lib/history/__tests__/series-filtering.test.ts` (new)

- [ ] Test regex validation function
  - [ ] Valid patterns accepted
  - [ ] Invalid patterns rejected
  - [ ] Pattern length limits enforced
  - [ ] ReDoS patterns rejected
- [ ] Test point filtering logic
  - [ ] Correct points matched by pattern
  - [ ] Correct points excluded by pattern
  - [ ] Empty pattern returns all points
- [ ] Test backward compatibility
  - [ ] No pattern = fetch all series (current behavior)

#### 3.2 Integration Tests

**File:** `app/api/__tests__/history-api.integration.test.ts`

- [ ] Add tests for `series` parameter
  - [ ] Valid pattern returns filtered series
  - [ ] Invalid pattern returns 400 error
  - [ ] Pattern matches expected series for EnergyChart
  - [ ] Pattern matches expected series for MondoChart
  - [ ] No pattern maintains backward compatibility
- [ ] Test interaction with `matchLegacy`
  - [ ] Both parameters work together correctly
  - [ ] Series filter applied before matchLegacy filter

#### 3.3 Performance Benchmarks

**File:** `scripts/benchmarks/history-performance.ts` (new)

- [ ] Benchmark current behavior (fetch all)
- [ ] Benchmark with EnergyChart pattern (5 series)
- [ ] Benchmark with MondoChart pattern (4-12 series)
- [ ] Compare query times
- [ ] Compare data transfer sizes
- [ ] Document results in this file

### Phase 4: Documentation & Deployment

#### 4.1 Update API Documentation

**File:** `docs/API.md`

- [ ] Document new `series` parameter
- [ ] Add examples for each chart type
- [ ] Document regex pattern syntax
- [ ] Document validation rules
- [ ] Add migration guide for existing clients

#### 4.2 Update CLAUDE.md

**File:** `CLAUDE.md`

- [ ] Add note about series filtering feature
- [ ] Document regex patterns for common use cases
- [ ] Add troubleshooting for regex issues

#### 4.3 Create Migration Guide

**File:** `docs/SERIES-FILTERING-MIGRATION.md` (new)

- [ ] Document migration path for existing clients
- [ ] Provide pattern examples for common use cases
- [ ] Document performance benefits
- [ ] Provide testing checklist

#### 4.4 Deployment Checklist

- [ ] Run all tests (unit + integration)
- [ ] Run performance benchmarks
- [ ] Test with production data
- [ ] Deploy to staging
- [ ] Test EnergyChart in staging (with matchLegacy=true)
- [ ] Test MondoChart in staging (with series parameter)
- [ ] Monitor performance metrics
- [ ] Deploy to production
- [ ] Monitor error rates and performance

## Design Decisions

### Decision 1: Series ID Format

**Current format:** `liveone.system.3.source.solar.power.avg`

**Keep current format for now:**

- ✅ Works fine with regex patterns
- ✅ No breaking changes needed
- ✅ Can change format in future if needed

**Alternative format:** `liveone/system.3/source.solar.power/avg`

- ❌ Breaking change - requires migration
- ⚠️ Consider for v2 API in future

**Decision:** Keep current format

### Decision 2: Regex Validation

**Strict validation (recommended):**

- Compile regex and catch errors
- Limit pattern length (200 chars)
- Timeout regex matching (10ms per series)
- Log suspicious patterns for security review

**Permissive validation:**

- Just check if regex compiles
- Trust frontend to send safe patterns

**Decision:** Use strict validation for security

### Decision 3: Backward Compatibility

**Approach:**

- `series` parameter is optional
- If not provided, fetch all series (current behavior)
- **Remove `matchLegacy` parameter entirely**
- Both EnergyChart and MondoChart will use `series` parameter

**Migration path:**

1. Deploy backend with `series` support
2. Update both MondoChart and EnergyChart to use `series` parameter
3. Remove `matchLegacy` parameter handling from API
4. Remove `LEGACY_SERIES_PATTERNS` from history-service.ts
5. Simplify code by removing legacy filtering logic

**Decision:** No backward compatibility with matchLegacy - clean break to new approach

### Decision 4: Multiple Patterns

**Both approaches supported:**

1. **Single regex pattern** (for power users):

   ```
   series=^load\.|^source\.solar\.
   ```

   - Full regex power (OR, groups, etc.)
   - More concise for complex patterns

2. **Multiple patterns** (easier for programmatic construction):
   ```
   series=^load\.&series=^source\.solar\.
   ```

   - Each pattern is a separate regex
   - Matches if ANY pattern matches (OR logic)
   - Easier to construct dynamically
   - Better for URL readability

**Decision:** Support both - check if query string has multiple `series` values. If multiple, treat as separate patterns with OR logic. If single, treat as single regex.

## Performance Expectations

### Expected Improvements

| Scenario                       | Current  | With Regex | Improvement  |
| ------------------------------ | -------- | ---------- | ------------ |
| **EnergyChart (5 series)**     |          |            |              |
| DB rows                        | 5,760    | 1,440      | 4x fewer     |
| Query time                     | 50-100ms | 15-25ms    | 3-5x faster  |
| Data transfer                  | 46 KB    | 11.5 KB    | 4x smaller   |
|                                |          |            |              |
| **MondoChart Load (8 series)** |          |            |              |
| DB rows                        | 5,760    | 2,304      | 2.5x fewer   |
| Query time                     | 50-100ms | 20-40ms    | 2-3x faster  |
| Data transfer                  | 46 KB    | 18 KB      | 2.5x smaller |

### Measurement Plan

Before and after implementation, measure:

1. Average API response time (p50, p95, p99)
2. Database query time
3. Response payload size
4. Number of series returned
5. Memory usage during processing

## Future Enhancements

### Phase 5: Series Catalog API

Add endpoint to discover available series:

```typescript
GET /api/series?systemId=3

Response:
{
  "series": [
    {
      "id": "source.solar.power.avg",
      "label": "Solar Power",
      "type": "power",
      "unit": "W",
      "path": "source.solar",
      "aggregation": "avg"
    },
    ...
  ]
}
```

**Use cases:**

- Dynamic UI for series selection
- Chart configuration builder
- API documentation generation

### Phase 6: Series Aggregation

Allow combining multiple series:

```typescript
GET /api/history?series=source\.solar\..*&aggregate=sum

// Returns sum of all matching solar series
```

### Phase 7: GraphQL API

Provide GraphQL interface for flexible queries:

```graphql
query {
  history(systemId: 3, interval: "5m", last: "24h") {
    series(pattern: "source\\.solar\\..*") {
      id
      label
      data {
        timestamp
        value
      }
    }
  }
}
```

## References

- History API implementation: `app/api/history/route.ts`
- History Service: `lib/history/history-service.ts`
- Point Readings Provider: `lib/history/point-readings-provider.ts`
- EnergyChart component: `components/EnergyChart.tsx`
- MondoChart component: `components/MondoPowerChart.tsx`
- Legacy series patterns: `lib/history/history-service.ts` lines 13-35
- API documentation: `docs/API.md`
