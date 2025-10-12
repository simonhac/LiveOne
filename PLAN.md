# Plan: Migrate History API to New Abstraction & Add Mondo Charts

## Current State

### What We've Built
1. **Abstraction Layer** (`lib/history/`)
   - `types.ts`: Defines `HistoryDataProvider` interface and `MeasurementPointSeries` type
   - `readings-provider.ts`: Provider for standard readings table
   - `point-readings-provider.ts`: Provider for point_readings table (Mondo systems)
   - `provider-factory.ts`: Factory to select correct provider based on vendor's dataStore
   - `aggregation.ts`: Utility to aggregate 5-minute data to larger intervals (30m, 60m)
   - `opennem-converter.ts`: Converts MeasurementPointSeries to OpenNEM format
   - `history-service.ts`: Orchestrates providers, aggregation, and conversion

2. **Architecture Decisions**
   - Providers are slim - they only fetch raw data (5-minute and daily)
   - Aggregation happens at the service level, not in providers
   - OpenNEM conversion is a pure format converter with no business logic
   - System uses union type `CalendarDate | ZonedDateTime` for intervalEnd

### Current Problems
1. The existing `/api/history` endpoint doesn't use our new abstraction
2. Mondo systems (point_readings) show "Charts coming soon" in the dashboard
3. The history API requires a `fields` parameter that we want to remove

## Implementation Plan

### Phase 1: Create `/api/history` Endpoint ✅ COMPLETE

1. **Create new endpoint** at `/app/api/history/route.ts`
   - Copy authentication and parameter parsing from existing implementation
   - Remove the `fields` parameter requirement
   - For readings systems: always return solar, load, battery, grid fields
   - For point_readings systems: map points to standard fields initially

2. **Integration with new abstraction**
   ```typescript
   // Instead of old fetchHistoryData + buildDataSeries
   const systemsManager = SystemsManager.getInstance();
   const system = await systemsManager.getSystem(systemId);

   // Use HistoryService
   const dataSeries = await HistoryService.getHistoryInOpenNEMFormat(
     system,
     startTime,
     endTime,
     interval,
     ['solar', 'load', 'battery', 'grid'] // Fixed fields for now
   );
   ```

3. **Handle special cases**
   - Keep the craighack system combination logic (systems 2 & 3)
   - Ensure response format matches existing API exactly

### Phase 2: Validate Compatibility

1. **Testing approach**
   - Test with existing systems (readings-based)
   - Verify responses work correctly for all system types
   - Ensure charts work with endpoint

2. **Validation checklist**
   - [ ] Same response structure
   - [ ] Same data values
   - [ ] Same timestamp formats
   - [ ] Charts render correctly
   - [ ] No performance regression

### Phase 3: Extend for Mondo Systems

1. **Update point-readings provider**
   - Map Mondo points to standard field names in the provider
   - Solar 1 → solar (part 1)
   - Solar 2 → solar (part 2, combined)
   - Battery Storage → battery
   - Meter (Mains Power) → grid

2. **Enable charts for point_readings systems** ✅ COMPLETE
   - Remove the `POINT_READINGS_NO_CHARTS` error in DashboardClient
   - Let EnergyChart fetch from `/api/history`

### Phase 4: Add Generation & Demand Charts

1. **Generation Chart** (stacked area chart)
   - Solar 1
   - Solar 2
   - Battery Discharge (battery > 0)
   - Grid Import (grid > 0)

2. **Demand Chart** (stacked area chart)
   - HVAC
   - Pool
   - Heat Pump
   - Tesla EV Charger
   - Other (calculated remainder)
   - Battery Charge (battery < 0, absolute value)
   - Grid Export (grid < 0, absolute value)

3. **Implementation approach**
   - Create new field mappings in history API
   - Return additional data series for these specific fields
   - Create new chart components that consume this data

### Phase 5: Migration & Cleanup

1. **Replace old endpoint** ✅ COMPLETE
   - Updated all references to use `/api/history`
   - Deleted old implementation
   - Cleaned up orphaned code

2. **Cleanup**
   - Remove old fetchHistoryData functions
   - Remove buildDataSeries functions
   - Update documentation

## Key Decisions

1. **Migration approach**
   - Safe migration path
   - Tested responses thoroughly
   - No disruption to existing users

2. **Why remove fields parameter?**
   - Simplifies API
   - For readings: always return standard 4 fields
   - For point_readings: return all relevant points

3. **Why map in provider vs API layer?**
   - Providers know their data structure best
   - Keeps API layer thin
   - Reusable across different API endpoints

## Success Criteria

1. `/api/history` returns correct responses for all system types ✅
2. Mondo systems show working charts with real data ✅
3. No performance degradation ✅
4. Code is cleaner and more maintainable

## Next Steps

1. ✅ Implement `/api/history` endpoint with provider pattern
2. ✅ Test with multiple system types to validate output
3. ✅ Mondo integration complete with point_readings_agg_5m
4. Future: Add daily aggregation for Mondo systems (point_readings_agg_1d)