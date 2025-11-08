# Load Calculations

This document describes how load calculations work in the mondo data processor, particularly the "Rest of House" calculation.

## Overview

The mondo data processor (`lib/mondo-data-processor.ts`) processes power data from various sources (generation, loads, battery) and prepares it for visualization in charts. One important calculated metric is "Rest of House" which represents unmeasured load.

## Rest of House Calculation

The "Rest of House" value represents electrical load that is not directly measured by individual load sensors. The calculation method depends on what data is available from the system.

### Three Cases

#### Case 1: Master Load WITH Child Loads

**Condition**: System has a master load point (path="load") AND individual load measurements (path="load.xxx")

**Calculation**:

```
Rest of House = Master Load - Sum(Child Loads)
```

**Example**:

- Master Load: 5 kW
- Kitchen (load.kitchen): 2 kW
- Living Room (load.living_room): 1.5 kW
- Rest of House: 5 - (2 + 1.5) = 1.5 kW

**Use Case**: Systems with a whole-house energy monitor plus individual circuit monitors.

---

#### Case 2: Master Load WITHOUT Child Loads

**Condition**: System has a master load point (path="load") but NO individual load measurements

**Calculation**: None - Rest of House is not calculated

**Reason**: If there's a master load but no breakdown, all load is already accounted for in the master measurement. There's nothing to calculate.

---

#### Case 3: No Master Load, WITH Child Loads

**Condition**: System has NO master load point but HAS individual load measurements (path="load.xxx") AND generation data

**Calculation**:

```
Rest of House = Total Generation - Sum(Known Loads)
```

**Example**:

- Solar Generation: 6 kW
- Heat Pump (load.heat_pump): 3 kW
- EV Charger (load.ev_charger): 1 kW
- Rest of House: 6 - (3 + 1) = 2 kW

**Use Case**: Systems without whole-house monitoring but with generation metering and selected circuit monitors. The difference between what's being generated and what's measured on individual circuits represents unmeasured load.

**Implementation Notes**:

- Total Generation is calculated by summing ALL series in generation mode (including battery discharge and grid import)
- Known Loads is calculated by summing ALL series in load mode (including battery charge and grid export)
- If path information is missing, all series in load mode are treated as loads to be summed
- Battery and grid are handled correctly through their bidirectional transformations in the series configuration

---

## Implementation Details

### Code Location

The calculation is performed in `lib/mondo-data-processor.ts`:

1. **Lines 204-205**: Process generation mode BEFORE load mode (required for Case 3)
2. **Lines 368-384**: Calculate total generation from all processed generation series
3. **Lines 257-297**: Accumulate load values (handling both path-based and path-less data)
4. **Lines 300-366**: Calculate Rest of House based on the three cases above

### Data Paths

The system identifies different types of measurements by their `path` attribute:

- `"load"` - Master/whole-house load
- `"load.xxx"` - Individual load circuits (e.g., "load.kitchen", "load.heat_pump")
- `"generation"` or `"generation.xxx"` - Generation sources (e.g., solar panels)
- `"bidi.battery"` - Bidirectional battery (charge/discharge)

### Null Handling

All calculations handle null values properly:

- If any required value is null at a given timestamp, the result is null for that timestamp
- Negative values are clamped to 0 (using `Math.max(0, rest)`)

### Console Logging

The processor logs which case was used:

- `"Case 1: Added rest of house (master load - child loads)"`
- `"Case 2: Master load exists but no child loads - skipping rest of house"`
- `"Case 3: Added rest of house (total generation - known loads)"`
- `"Cannot calculate rest of house - insufficient data"` (if none of the cases apply)

## Energy vs Power Mode

The calculations work in both power mode (kW) and energy mode (kWh):

- **1D and 7D views**: Power mode - instantaneous measurements in kilowatts (kW)
- **30D view**: Energy mode - accumulated energy in kilowatt-hours (kWh)

All raw data from the API is in Watts (W) and gets converted to kW during processing.

## Visualization

The "Rest of House" series is displayed:

- **Color**: Gray (`rgb(107, 114, 128)` - gray-500)
- **Order**: Appears after all individual loads in the chart
- **Chart Type**: Stacked area chart (load view)

This helps users identify unmeasured consumption in their system.
