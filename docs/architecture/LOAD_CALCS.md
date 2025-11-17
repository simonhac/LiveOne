# Load Calculations

This document describes how load calculations work in the site data processor, particularly the "Rest of House" calculation.

## Overview

The site data processor (`lib/site-data-processor.ts`) processes power data from various sources (generation, loads, battery) and prepares it for visualization in charts. One important calculated metric is "Rest of House" which represents unmeasured load.

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

#### Case 3: No Master Load, WITH Generation Data

**Condition**: System has NO master load point but HAS generation data (and optionally individual load measurements)

**Calculation**:

```
Rest of House = Total Generation - Battery Charge - Grid Export - Sum(Known Circuit Loads)
```

**Example**:

- Solar Generation: 8.9 kW
- Battery Charge: 8.2 kW
- Grid Export: 0.1 kW
- Known Circuit Loads: 0 kW (no circuit monitors)
- Rest of House: 8.9 - 8.2 - 0.1 - 0 = 0.6 kW

**Use Case**: Systems without whole-house monitoring but with generation metering and optionally selected circuit monitors. The calculation determines unmeasured load by accounting for where the generation is going (battery, grid, measured loads, and the remainder).

**Implementation Notes**:

- Total Generation is calculated by summing ALL series in generation mode (solar, battery discharge, grid import)
- Battery Charge and Grid Export are tracked separately from their raw bidi series (negative values transformed to positive)
- Known Circuit Loads only includes series with path="load.xxx"
- If any component (battery charge, grid export, or known loads) is missing, it's treated as 0
- This ensures the energy balance: Generation = Battery Charge + Grid Export + Measured Loads + Rest of House

---

## Implementation Details

### Code Location

The calculation is performed in `lib/site-data-processor.ts`:

1. **`calculateRestOfHouse()` function**: Contains the core logic for all three calculation cases
2. **Generation processing**: Total generation is calculated from all processed generation series (required for Case 3)
3. **Load accumulation**: Tracks both master load and child load values (handling both path-based and path-less data)
4. **Mode processing order**: Generation mode is processed BEFORE load mode to ensure total generation is available for Case 3

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

- `"Case 1: Added rest of house (master - children)"`
- `"Case 2: Master load exists, no children - skipping rest of house"`
- `"Case 3: Added rest of house (generation - battery - grid - children)"`
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
