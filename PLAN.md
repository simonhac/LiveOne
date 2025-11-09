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
     ["solar", "load", "battery", "grid"], // Fixed fields for now
   );
   ```

3. **Handle special cases**
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

### Phase 4: Add Generation & Load Charts ✅ COMPLETE

1. **MondoPowerChart Component** (`components/MondoPowerChart.tsx`)
   - Reusable chart component with two modes: 'load' and 'generation'
   - Fetches data from `/api/history` endpoint
   - Proper Chart.js stacked area fills with `fill: 'stack'`
   - Supports external period control (1D/7D/30D)
   - Time-based annotations for daylight hours and weekdays

2. **Generation Chart** (stacked area chart)
   - Solar 1
   - Solar 2
   - Battery Storage
   - Meter (Mains Power)

3. **Load Chart** (stacked area chart)
   - Tesla EV Charger
   - Heat Pump
   - Pool
   - HVAC

4. **Dashboard Integration** (`components/DashboardClient.tsx`)
   - Combined both charts in single card at full width
   - Shared period switcher controls both charts
   - Load chart positioned above generation chart
   - Increased height by 25% (375px)
   - Only displays for mondo vendor type systems

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
3. Generation and load stacked area charts implemented for Mondo systems ✅
4. No performance degradation ✅
5. Code is cleaner and more maintainable ✅

## Completed Work

1. ✅ Implement `/api/history` endpoint with provider pattern
2. ✅ Test with multiple system types to validate output
3. ✅ Mondo integration complete with point_readings_agg_5m
4. ✅ MondoPowerChart component with stacked area charts
5. ✅ Combined charts with shared period control in dashboard

## Future Enhancements

1. Add daily aggregation for Mondo systems (point_readings_agg_1d)
2. Consider adding calculated fields (e.g., "Other" load category)
3. Add energy totals panel for Mondo systems
