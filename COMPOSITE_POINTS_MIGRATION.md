# Composite Points Migration - Changes & TODOs

## Completed Changes

### 1. API Endpoint Updated ([app/api/data/route.ts](app/api/data/route.ts))

- **Changed**: `latest` section now returns composite points data from KV cache
- **Format**: `Record<string, { value, measurementTime, receivedTime, metricUnit }>`
- **Example**:
  ```json
  {
    "latest": {
      "source.solar.local/power": {
        "value": 141.23,
        "measurementTime": "2025-11-15T05:57:03+10:00",
        "receivedTime": "2025-11-15T05:57:03+10:00",
        "metricUnit": "W"
      },
      "bidi.battery/soc": {
        "value": 16.7,
        "measurementTime": "2025-11-15T05:57:00+10:00",
        "receivedTime": "2025-11-15T05:57:01+10:00",
        "metricUnit": "%"
      }
    }
  }
  ```

### 2. TypeScript Types ([lib/types/api.ts](lib/types/api.ts))

- **Created**: Centralized API response types
  - `PointValueFormatted`: Single point value with formatted timestamps
  - `LatestPointValuesFormatted`: Map of point paths to values
- **Used by**: Backend API and frontend DashboardClient

### 3. Dashboard Power Cards ([components/DashboardClient.tsx](components/DashboardClient.tsx))

- **Solar Card**: Smart logic for different configurations
  - Only `source.solar/power` → show total only
  - `source.solar/power` + one child → show total only
  - `source.solar/power` + both children → show total + breakdown
  - No total but both children → calculate total + show breakdown

- **Load Card**: Uses `load/power` point

- **Battery Card**:
  - SOC from `bidi.battery/soc`
  - Power from `bidi.battery/power` (sign indicates charge/discharge)

- **Grid Card**:
  - Power from `bidi.grid/power` (sign indicates import/export)

### 4. Helper Functions

- `getPointValue(latest, pointPath)`: Safely extract point values
- `getMeasurementTime(latest, pointPath)`: Get timestamp for staleness calc

---

## Temporarily Disabled Features

### 1. Fault Warning Display

**Location**: [components/DashboardClient.tsx:1188-1217](components/DashboardClient.tsx#L1188-L1217)

**What was removed**:

- Display of fault codes from vendor systems
- Previously from `data.latest.system.faultCode` and `data.latest.system.faultTimestamp`

**To restore**:

1. Add fault code points to composite system:
   - `system.fault/code` (number)
   - `system.fault/timestamp` (unix timestamp or use measurementTime)
2. Update fault warning section to use:
   ```typescript
   const faultCode = getPointValue(data.latest, "system.fault/code");
   const faultTime = getMeasurementTime(data.latest, "system.fault/code");
   ```

### 2. Energy Panel

**Location**: [components/DashboardClient.tsx:1798-1822](components/DashboardClient.tsx#L1798-L1822)

**What was removed**:

- Today's energy totals (solar, load, battery in/out, grid in/out)
- Lifetime energy totals
- Previously from `data.latest.energy.today.*` and `data.latest.energy.total.*`

**To restore**:

1. Add energy counter points to composite system for each metric:
   - `source.solar/energy_today` (kWh)
   - `source.solar/energy_total` (kWh)
   - `load/energy_today` (kWh)
   - `load/energy_total` (kWh)
   - `bidi.battery/energy_in_today` (kWh)
   - `bidi.battery/energy_in_total` (kWh)
   - `bidi.battery/energy_out_today` (kWh)
   - `bidi.battery/energy_out_total` (kWh)
   - `bidi.grid/energy_in_today` (kWh)
   - `bidi.grid/energy_in_total` (kWh)
   - `bidi.grid/energy_out_today` (kWh)
   - `bidi.grid/energy_out_total` (kWh)

2. Construct energy object from points:

   ```typescript
   const energy = {
     today: {
       solarKwh: getPointValue(data.latest, "source.solar/energy_today"),
       loadKwh: getPointValue(data.latest, "load/energy_today"),
       batteryInKwh: getPointValue(data.latest, "bidi.battery/energy_in_today"),
       batteryOutKwh: getPointValue(
         data.latest,
         "bidi.battery/energy_out_today",
       ),
       gridInKwh: getPointValue(data.latest, "bidi.grid/energy_in_today"),
       gridOutKwh: getPointValue(data.latest, "bidi.grid/energy_out_today"),
     },
     total: {
       solarKwh: getPointValue(data.latest, "source.solar/energy_total"),
       loadKwh: getPointValue(data.latest, "load/energy_total"),
       batteryInKwh: getPointValue(data.latest, "bidi.battery/energy_in_total"),
       batteryOutKwh: getPointValue(
         data.latest,
         "bidi.battery/energy_out_total",
       ),
       gridInKwh: getPointValue(data.latest, "bidi.grid/energy_in_total"),
       gridOutKwh: getPointValue(data.latest, "bidi.grid/energy_out_total"),
     },
   };
   ```

3. Uncomment EnergyPanel and pass constructed energy object

---

## TODO: Future Enhancements

### 1. ISO8601 Date Revivor

Add automatic date parsing for API responses:

```typescript
// In fetch calls, add revivor:
const response = await fetch("/api/data?systemId=1");
const data = await response.json((key, value) => {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(value)
  ) {
    return new Date(value);
  }
  return value;
});
```

This would eliminate manual date parsing throughout the codebase.

### 2. Show Grid Logic

Currently checking if `bidi.grid/power` point exists. Should be updated to use lifetime grid energy totals when available:

```typescript
const showGrid =
  (getPointValue(data.latest, "bidi.grid/energy_in_total") || 0) > 0 ||
  (getPointValue(data.latest, "bidi.grid/energy_out_total") || 0) > 0;
```

---

## Testing Checklist

- [ ] Solar card displays correctly with different point configurations
- [ ] Load card shows load power
- [ ] Battery card shows SOC and charge/discharge status
- [ ] Grid card shows import/export status
- [ ] Staleness indicators work correctly
- [ ] Composite systems (e.g., system 8) show aggregated values
- [ ] No console errors
- [ ] TypeScript compilation succeeds

---

## Point Path Reference

### Power Points

- `source.solar/power` - Total solar power (W)
- `source.solar.local/power` - Local solar array power (W)
- `source.solar.remote/power` - Remote solar array power (W)
- `load/power` - Total load power (W)
- `load.hvac/power` - HVAC load (W)
- `load.pool/power` - Pool pump load (W)
- `bidi.battery/power` - Battery power (W, negative = charging)
- `bidi.grid/power` - Grid power (W, positive = importing)

### State of Charge

- `bidi.battery/soc` - Battery state of charge (%)

### Energy Counters (To be implemented)

- `<type>/energy_today` - Today's energy for this point (kWh)
- `<type>/energy_total` - Lifetime energy for this point (kWh)

### System Status (To be implemented)

- `system.fault/code` - Active fault code
- `system.fault/timestamp` - When fault occurred
- `system.generator/status` - Generator status code
