# Points System Documentation

## Table of Contents

- [Introduction](#introduction)
- [Core Concepts](#core-concepts)
- [Database Schema](#database-schema)
- [Point Lifecycle](#point-lifecycle)
- [Configuration](#configuration)
- [User Interface](#user-interface)
- [API Reference](#api-reference)
- [Composite Systems](#composite-systems)
- [Integration](#integration)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

## Introduction

### What Are Points?

**Points** are individual monitoring metrics from a solar/battery system. Each point represents a specific measurement or value that changes over time.

**Examples of points:**

- Battery State of Charge (%)
- Solar Power (W)
- Grid Import Energy (Wh)
- Load Power (W)
- Battery Temperature (°C)

### Why Points?

The Points system provides:

1. **Granular control** - Enable/disable individual metrics instead of entire categories
2. **Flexible organization** - Create custom hierarchies for different display contexts
3. **Vendor independence** - Normalize different vendor data models into a common structure
4. **Composite systems** - Aggregate metrics from multiple physical systems
5. **User customization** - Users can rename, organize, and configure their own points

## Core Concepts

### Terminology

| Term              | Description                                    | Example                                 |
| ----------------- | ---------------------------------------------- | --------------------------------------- |
| **Point**         | A single measurable value from a system        | "Battery SOC"                           |
| **System**        | A physical solar/battery installation          | "Daylesford Selectronic"                |
| **Metric Type**   | The kind of measurement                        | `power`, `energy`, `soc`, `temperature` |
| **Metric Unit**   | The unit of measurement                        | `W`, `Wh`, `%`, `°C`                    |
| **Origin ID**     | Vendor's identifier for the measurement source | `"E1"` (Amber import channel)           |
| **Origin Sub ID** | Vendor's identifier for the specific metric    | `"kwh"` (energy reading)                |
| **Series Path**   | Hierarchical identifier for categorization     | `source.solar.local`                    |
| **Subsystem**     | Functional grouping set at creation            | `solar`, `battery`, `grid`, `load`      |

### Point Identity

Each point has **multiple identifiers** used in different contexts:

```typescript
// Database identity (unique within system)
systemId: 1;
id: 5; // Sequential per system

// Vendor identity (how vendor identifies this metric)
originId: "E1"; // Vendor's source identifier
originSubId: "kwh"; // Vendor's metric identifier

// User identity
displayName: "Grid Import Energy"; // User-friendly name
alias: "grid_import"; // Optional short identifier for URLs/APIs

// Hierarchical identity (for categorization)
subsystem: "grid"; // Functional group (set at creation, immutable)
type: "bidi"; // User-editable category
subtype: "grid"; // User-editable subcategory
extension: "energy"; // User-editable qualifier
```

### Series Paths

Series paths are hierarchical identifiers built from configurable fields:

```
type.subtype.extension
```

**Examples:**

```
source.solar             // Total solar (no extension)
source.solar.local       // Solar from local CT measurement
source.solar.remote      // Solar from remote inverter
bidi.battery             // Battery power (bidirectional)
bidi.battery.soc         // Battery state of charge
bidi.grid                // Grid power (bidirectional)
load                     // Total load (no type, just subsystem)
```

**Path Rules:**

- All segments are optional
- Use dot notation for hierarchy
- Path determines composite category eligibility
- User can modify to customize organization

### Subsystem vs Type

| Field         | Set By                           | Editable | Purpose                           |
| ------------- | -------------------------------- | -------- | --------------------------------- |
| **subsystem** | Vendor adapter at point creation | ❌ No    | Functional grouping for UI panels |
| **type**      | User (via Point Info modal)      | ✅ Yes   | Top-level category in series path |

**Subsystem** groups points by function (solar, battery, grid, load, inverter, other) for display in UI panels.

**Type** is part of the user-editable series path hierarchy used for categorization and composite mappings.

### Metric Types and Transforms

Points have a **metric type** that determines how values are stored and aggregated:

| Metric Type   | Description            | Units     | Aggregation         | Transform   |
| ------------- | ---------------------- | --------- | ------------------- | ----------- |
| `power`       | Instantaneous power    | W         | avg, min, max, last | `n` (none)  |
| `energy`      | Accumulated energy     | Wh        | delta (sum)         | `d` (delta) |
| `soc`         | State of charge        | %         | avg, min, max, last | `n` (none)  |
| `proportion`  | Percentage/ratio       | %         | avg                 | `n` (none)  |
| `rate`        | Price or tariff        | cents/kWh | avg                 | `n` (none)  |
| `value`       | Cost or monetary value | cents     | delta (sum)         | `d` (delta) |
| `code`        | Status or state code   | -         | last                | `n` (none)  |
| `temperature` | Temperature            | °C        | avg, min, max       | `n` (none)  |

**Transform field:**

- `n` or `null` - No transform (store value as-is)
- `d` - Delta transform (calculate difference between readings)

Energy and value metrics use delta transform to convert cumulative totals into interval changes.

## Database Schema

### point_info Table

Stores metadata and configuration for each point.

**Primary Key:** Composite `(system_id, id)`

```sql
CREATE TABLE point_info (
  -- Identity (composite primary key)
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,                -- Sequential per system (1, 2, 3...)

  -- Vendor identity
  origin_id TEXT NOT NULL,            -- Vendor's source identifier
  origin_sub_id TEXT,                 -- Vendor's metric identifier (optional)

  -- Display information
  point_name TEXT NOT NULL,           -- Canonical name (vendor default)
  display_name TEXT NOT NULL,         -- User-editable display name
  alias TEXT,                         -- Optional short identifier (alphanumeric + underscore)

  -- Hierarchical classification
  subsystem TEXT,                     -- Functional group: solar, battery, grid, load, inverter, other
  type TEXT,                          -- Series path segment 1 (user editable)
  subtype TEXT,                       -- Series path segment 2 (user editable)
  extension TEXT,                     -- Series path segment 3 (user editable)

  -- Metric information
  metric_type TEXT NOT NULL,          -- power, energy, soc, etc.
  metric_unit TEXT NOT NULL,          -- W, Wh, %, etc.

  -- Configuration
  active INTEGER NOT NULL DEFAULT 1,  -- Boolean: 1 = enabled, 0 = disabled
  transform TEXT,                     -- 'd' = delta, 'n' or null = none

  -- Metadata
  created INTEGER NOT NULL DEFAULT 0, -- Unix timestamp (milliseconds)

  PRIMARY KEY (system_id, id),
  UNIQUE (system_id, origin_id, origin_sub_id),
  UNIQUE (system_id, alias) WHERE alias IS NOT NULL
);
```

**Key Constraints:**

1. **Composite Primary Key**: `(system_id, id)` - Points are numbered sequentially per system
2. **Vendor Uniqueness**: `(system_id, origin_id, origin_sub_id)` - Each vendor metric maps to one point
3. **Alias Uniqueness**: `alias` must be unique within a system (when not null)

### point_readings Table

Stores raw time-series data for points.

```sql
CREATE TABLE point_readings (
  system_id INTEGER NOT NULL,
  point_id INTEGER NOT NULL,
  measurement_time INTEGER NOT NULL,   -- Unix timestamp (milliseconds)
  value REAL,

  PRIMARY KEY (system_id, point_id, measurement_time),
  FOREIGN KEY (system_id, point_id) REFERENCES point_info(system_id, id)
);
```

### point_readings_agg_5m Table

Stores 5-minute aggregated data for points.

```sql
CREATE TABLE point_readings_agg_5m (
  system_id INTEGER NOT NULL,
  point_id INTEGER NOT NULL,
  interval_end INTEGER NOT NULL,       -- Unix timestamp (milliseconds)

  -- Aggregated values
  avg REAL,                            -- Average value in interval
  min REAL,                            -- Minimum value in interval
  max REAL,                            -- Maximum value in interval
  last REAL,                           -- Last value in interval
  delta REAL,                          -- For energy: sum of deltas

  -- Metadata
  sample_count INTEGER NOT NULL,       -- Number of samples in interval
  error_count INTEGER NOT NULL,        -- Number of errors in interval
  session_id INTEGER,                  -- Session that created this data
  value_str TEXT,                      -- For code metrics (non-numeric)
  data_quality TEXT,                   -- Quality indicator
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (system_id, point_id, interval_end),
  FOREIGN KEY (system_id, point_id) REFERENCES point_info(system_id, id)
);
```

**Aggregation Rules:**

| Metric Type | Uses avg | Uses min/max | Uses last | Uses delta |
| ----------- | -------- | ------------ | --------- | ---------- |
| power       | ✅       | ✅           | ✅        | ❌         |
| energy      | ❌       | ❌           | ✅        | ✅ (sum)   |
| soc         | ✅       | ✅           | ✅        | ❌         |
| value       | ❌       | ❌           | ✅        | ✅ (sum)   |
| code        | ❌       | ❌           | ✅        | ❌         |

## Point Lifecycle

### 1. Point Creation (Vendor Adapters)

Points are created by **vendor adapters** when they first receive data from a system.

**Example: Selectronic Adapter**

```typescript
// lib/vendors/selectronic/point-metadata.ts
export function getSelectronicPoints(): PointMetadata[] {
  return [
    {
      originId: "solar",
      originSubId: null,
      pointName: "Solar",
      subsystem: "solar",
      type: "source",
      subtype: "solar",
      extension: null,
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
    {
      originId: "battery",
      originSubId: "soc",
      pointName: "Battery SOC",
      subsystem: "battery",
      type: "bidi",
      subtype: "battery",
      extension: "soc",
      metricType: "soc",
      metricUnit: "%",
      transform: null,
    },
    // ... more points
  ];
}
```

**Point Manager** creates points in the database:

```typescript
// lib/point/monitoring-point-manager.ts
await pointManager.ensurePoints(systemId, pointMetadataArray);
```

This:

1. Checks if point exists by `(system_id, origin_id, origin_sub_id)`
2. Creates point if not found, assigns sequential `id`
3. Updates metadata if point exists but metadata changed

### 2. Data Collection (Polling/Push)

Vendor adapters collect data and write to `point_readings`:

```typescript
// Example: Writing a reading
await pointManager.writeReading(systemId, pointId, {
  measurementTime: Date.now(),
  value: 2500, // Watts
});
```

### 3. Aggregation (Cron Jobs)

Every 5 minutes, a cron job aggregates raw readings:

```typescript
// Aggregates readings into point_readings_agg_5m
// - Calculates avg, min, max, last
// - For energy metrics: sums deltas
// - Tracks sample count and data quality
```

### 4. Configuration (Users)

Users can configure points via Point Info modal:

- Enable/disable (`active` flag)
- Rename (`display_name`)
- Set alias for URLs/APIs
- Categorize (modify `type`, `subtype`, `extension`)

### 5. Querying (History API)

History API reads from aggregated tables, filtering by `active` flag:

```typescript
// Only returns data for active points
const activePoints = points.filter((p) => p.active === 1);
```

### 6. Deactivation

Users can disable points without deleting data:

- Set `active = 0`
- Point hidden from most views
- Historical data preserved
- Can be re-enabled later

## Configuration

### Active Flag

The `active` field determines whether a point is enabled:

```sql
active INTEGER NOT NULL DEFAULT 1  -- 1 = enabled, 0 = disabled
```

**When active = 1:**

- Point appears in data queries
- Included in composite mappings
- Shown in UI (not strikethrough)
- Data continues to be collected

**When active = 0:**

- Point hidden from data queries
- Excluded from composite mappings
- Shown with strikethrough in UI
- Data collection may continue (vendor-dependent)

**Use cases for disabling points:**

- Hide redundant metrics
- Simplify dashboard views
- Exclude test/calibration points
- Temporarily disable without losing historical data

### Display Name

User-friendly name shown in UI:

```sql
display_name TEXT NOT NULL
```

**Rules:**

- Required (cannot be empty)
- User-editable
- No uniqueness constraint
- Used in all UI displays

**Best practices:**

- Descriptive and clear
- Consistent naming within system
- Include units if helpful ("Battery SOC (%)")

### Alias (Short Name)

Optional short identifier for URLs and APIs:

```sql
alias TEXT,  -- Unique within system
UNIQUE (system_id, alias) WHERE alias IS NOT NULL
```

**Rules:**

- Optional
- Must be unique within system
- Alphanumeric and underscore only (`/^[a-zA-Z0-9_]+$/`)
- Max 200 characters

**Use cases:**

- URL-friendly identifiers: `/dashboard/user/solar_main`
- API endpoints: `/api/points/grid_import`
- Short references in scripts/tools

**Examples:**

```
battery_soc
solar_main
grid_export
load_total
```

### Series Path Fields

Three user-editable fields build the hierarchical path:

```sql
type TEXT,       -- Top-level category
subtype TEXT,    -- Subcategory
extension TEXT   -- Additional qualifier
```

**Resulting path:** `type.subtype.extension`

**Common patterns:**

| Type     | Subtype   | Extension | Series Path           | Description     |
| -------- | --------- | --------- | --------------------- | --------------- |
| `source` | `solar`   | null      | `source.solar`        | Total solar     |
| `source` | `solar`   | `local`   | `source.solar.local`  | Local solar CT  |
| `source` | `solar`   | `remote`  | `source.solar.remote` | Remote inverter |
| `bidi`   | `battery` | null      | `bidi.battery`        | Battery power   |
| `bidi`   | `battery` | `soc`     | `bidi.battery.soc`    | Battery SOC     |
| `bidi`   | `grid`    | null      | `bidi.grid`           | Grid power      |
| `load`   | null      | null      | `load`                | Total load      |

**Type values:**

- `source` - Energy sources (solar)
- `bidi` - Bidirectional (battery, grid)
- `load` - Consumption
- Custom values allowed

**Subtype values:**

- `solar`, `battery`, `grid` - Standard subsystems
- Custom values allowed for specialized cases

**Extension values:**

- `power` - Power measurement
- `energy` - Energy accumulation
- `soc` - State of charge
- `local` - Local measurement source
- `remote` - Remote measurement source
- Custom values allowed

### Transform

Determines how values are processed:

```sql
transform TEXT  -- 'd' = delta, 'n' or null = none
```

**Transform types:**

| Value           | Name  | Purpose                               | Used For                        |
| --------------- | ----- | ------------------------------------- | ------------------------------- |
| `null` or `'n'` | None  | Store value as-is                     | Power, SOC, temperature, codes  |
| `'d'`           | Delta | Calculate difference between readings | Energy, cost, cumulative values |

**Example - Energy with delta transform:**

```
Reading 1: 1000 Wh (cumulative)
Reading 2: 1250 Wh (cumulative)
Delta: 250 Wh (energy produced in interval)
```

The delta transform converts cumulative totals into interval changes for proper aggregation.

## User Interface

### Point Info Modal

**Component:** `components/PointInfoModal.tsx`

Modal dialog for editing individual point configuration.

**Editable Fields:**

| Field        | Control    | Validation                                                |
| ------------ | ---------- | --------------------------------------------------------- |
| Active       | Checkbox   | Required boolean                                          |
| Display Name | Text input | Required, non-empty                                       |
| Alias        | Text input | Optional, alphanumeric + underscore, unique within system |
| Type         | Dropdown   | Optional, predefined options + custom                     |
| Subtype      | Text input | Optional, free text                                       |
| Extension    | Text input | Optional, free text                                       |
| Transform    | Dropdown   | `n` (none) or `d` (delta)                                 |

**Read-Only Fields:**

- Point Name (vendor default)
- Subsystem
- Metric Type
- Metric Unit
- Origin ID
- Origin Sub ID

**UI Features:**

- Real-time validation
- Error messages for invalid input
- Dirty state tracking (red dot on tab)
- Keyboard support (Enter to save, Escape to cancel)

### Capabilities Tab

**Component:** `components/CapabilitiesTab.tsx`

Read-only view of all points grouped by subsystem.

**Display:**

```
┌─ Solar ─────────────────────────────────┐
│ source.solar                             │
│   • Solar Power (2500 W)                 │
│ source.solar.local                       │
│   • Local Solar (1500 W)                 │
│ source.solar.remote                      │
│   • Remote Solar (1000 W)                │
└──────────────────────────────────────────┘

┌─ Battery ───────────────────────────────┐
│ bidi.battery                             │
│   • Battery Power (-700 W)               │
│ bidi.battery.soc                         │
│   • Battery SOC (85.5 %)                 │
└──────────────────────────────────────────┘
```

**Features:**

- Grouped by subsystem (solar, battery, grid, load, inverter, other)
- Color-coded subsystem panels
- Hierarchical tree structure
- Shows active/inactive status:
  - Active: Normal text
  - Inactive: Strikethrough, reduced opacity
- Read-only (no editing)

### View Data Modal

**Component:** `components/ViewDataModal.tsx`

Shows current/historical data with point configuration awareness.

**Point Display:**

```
┌─ Current Values ────────────────────────┐
│ Solar Power:        2500 W               │
│ Battery SOC:        85.5 %               │
│ Grid Power:         -150 W (exporting)   │
│ Load Power:         1800 W               │
│ Inactive Point:     --- (disabled)       │  ← Strikethrough
└──────────────────────────────────────────┘
```

**Features:**

- Shows point alias if available
- Inactive points shown with strikethrough
- Click point name to open Point Info modal
- Real-time data updates

### System Settings Dialog

**Component:** `components/SystemSettingsDialog.tsx`

Main dialog for system configuration with multiple tabs.

**Tabs:**

1. **General** - System display name, alias, timezone
2. **Capabilities** - Point configuration (read-only view)
3. **Composite** - Composite mappings (if composite system)
4. **Admin** - Admin settings (admin only)

**Save Behavior:**

- Each tab saves independently
- Visual indicator for unsaved changes (red dot)
- Validation before save
- Error messages for failures

## API Reference

### Get User's Points

**Endpoint:** `GET /api/admin/user/[userId]/points`

Returns all points from user's non-composite systems, grouped by system.

**Parameters:**

- `[userId]` - Clerk user ID

**Response:**

```json
{
  "success": true,
  "points": [
    {
      "systemId": 1,
      "pointId": 5,
      "originId": "battery",
      "originSubId": "soc",
      "pointName": "Battery",
      "displayName": "Battery SOC",
      "alias": "batt_soc",
      "subsystem": "battery",
      "type": "bidi",
      "subtype": "battery",
      "extension": "soc",
      "metricType": "soc",
      "metricUnit": "%",
      "active": true,
      "transform": null
    }
  ],
  "systems": [
    {
      "id": 1,
      "displayName": "Daylesford Selectronic",
      "alias": "daylesford"
    }
  ]
}
```

### Update Point Configuration

**Endpoint:** `PATCH /api/admin/points/[systemId].[pointId]`

Updates configuration for a specific point.

**Request Body:**

```json
{
  "active": true,
  "displayName": "Battery State of Charge",
  "alias": "batt_soc",
  "type": "bidi",
  "subtype": "battery",
  "extension": "soc",
  "transform": "n"
}
```

**All fields optional except:**

- At least one field must be provided

**Validation:**

- `alias` must match `/^[a-zA-Z0-9_]+$/`
- `alias` must be unique within system
- `displayName` cannot be empty if provided

**Response:**

```json
{
  "success": true,
  "message": "Point updated successfully",
  "point": {
    "systemId": 1,
    "pointId": 5,
    "displayName": "Battery State of Charge",
    "alias": "batt_soc",
    "active": true,
    "type": "bidi",
    "subtype": "battery",
    "extension": "soc"
  }
}
```

## Composite Systems

Composite systems aggregate data from multiple source systems by mapping categories to specific points.

### Metadata Structure

**Version 2 Format:**

```json
{
  "version": 2,
  "mappings": {
    "solar": ["1.5", "10.3"],
    "battery": ["1.7", "10.4"],
    "load": ["1.8", "10.6"],
    "grid": ["1.9"]
  }
}
```

**Mapping Format:** `"{systemId}.{pointId}"`

- Must be numeric values
- Points must exist and be active
- Points must have compatible series paths for category

### Category Requirements

Each category only accepts points with compatible series paths:

| Category  | Required Path Pattern              | Examples                             |
| --------- | ---------------------------------- | ------------------------------------ |
| `solar`   | `source.solar` or `source.solar.*` | `source.solar`, `source.solar.local` |
| `battery` | `bidi.battery` or `bidi.battery.*` | `bidi.battery`, `bidi.battery.soc`   |
| `load`    | `load` or `load.*`                 | `load`, `load.critical`              |
| `grid`    | `bidi.grid` or `bidi.grid.*`       | `bidi.grid`                          |

**Validation:**

- Frontend and backend both validate
- Clear error messages for incompatible mappings
- Points filtered by compatibility before display

### Composite Tab UI

**Component:** `components/CompositeTab.tsx`

**Features:**

- Category panels (solar, battery, load, grid)
- Add button opens filtered point picker
- Points grouped by source system
- Shows: **System Name** Point Name (series path)
- Remove button (X icon)
- Drag to reorder (future)

**Point Selection:**

```
┌─ Add Solar Points ──────────────────┐
│ Daylesford Selectronic              │
│   ☐ Solar Power (source.solar)      │
│   ☐ Local Solar (source.solar.local)│
│                                      │
│ Kinkora Fronius                      │
│   ☐ Solar (source.solar)             │
│                                      │
│         [Cancel]  [Add Selected]     │
└──────────────────────────────────────┘
```

Only shows points compatible with the category.

### API Endpoints

#### Get Composite Config

**Endpoint:** `GET /api/admin/systems/[systemId]/composite-config`

Returns current composite configuration.

**Response:**

```json
{
  "success": true,
  "metadata": {
    "version": 2,
    "mappings": {
      "solar": ["1.5", "10.3"],
      "battery": ["1.7"],
      "load": ["1.8"],
      "grid": ["1.9"]
    }
  }
}
```

#### Update Composite Config

**Endpoint:** `PATCH /api/admin/systems/[systemId]/composite-config`

Updates composite mappings with validation.

**Request Body:**

```json
{
  "mappings": {
    "solar": ["1.5", "10.3"],
    "battery": ["1.7"],
    "load": ["1.8"],
    "grid": ["1.9"]
  }
}
```

**Validation:**

- All values must be arrays of strings
- Point IDs must be format `"systemId.pointId"` with numeric parts
- Points must exist in database
- Points must be active
- Points must have compatible paths for category

**Error Response:**

```json
{
  "success": false,
  "error": "Invalid mapping for solar category",
  "details": "Point 10.3 has path 'bidi.battery' which is not compatible with solar category (requires source.solar or source.solar.*)"
}
```

## Integration

### Vendor Adapters

Vendor adapters create and manage points for their systems.

**Key responsibilities:**

1. **Define point metadata** - Specify originId, subsystem, metric type, etc.
2. **Create points** - Ensure points exist before writing data
3. **Write readings** - Store measurements in point_readings
4. **Handle errors** - Track and report collection failures

**Example: Amber Electric**

```typescript
// lib/vendors/amber/point-metadata.ts
export function getAmberPoints(): PointMetadata[] {
  return [
    {
      originId: "E1", // Import channel
      originSubId: "kwh", // Energy reading
      pointName: "Grid Import",
      subsystem: "grid",
      type: "bidi",
      subtype: "grid",
      extension: "energy",
      metricType: "energy",
      metricUnit: "Wh",
      transform: "d", // Delta for cumulative energy
    },
    // ... more points
  ];
}
```

### Aggregation System

The aggregation system processes raw readings into 5-minute intervals.

**Process:**

1. **Triggered by:** Cron job every 5 minutes
2. **Reads from:** `point_readings` table
3. **Groups by:** 5-minute intervals (aligned to :00, :05, :10, etc.)
4. **Calculates:**
   - `avg` - Mean of samples
   - `min` - Minimum value
   - `max` - Maximum value
   - `last` - Last value in interval
   - `delta` - For energy: sum of differences
5. **Writes to:** `point_readings_agg_5m` table

**Delta calculation for energy:**

```typescript
// For each consecutive pair of readings
delta = reading2.value - reading1.value

// Aggregate into interval
intervalDelta = sum(all deltas in interval)
```

### History API

The History API reads aggregated data, filtering by active status.

**Key behavior:**

- Only queries points where `active = 1`
- Uses series paths for data selection
- Supports glob patterns for path matching
- Returns data in vendor-neutral format

**Example query:**

```typescript
// Get all solar power readings (5-minute avg)
GET /api/history?seriesPattern=source.solar*&interval=5m&period=1d
```

## Best Practices

### Point Configuration

**✅ Do:**

- Use descriptive display names ("Battery State of Charge" not "Batt SOC")
- Set type/subtype/extension consistently across similar systems
- Use aliases for frequently accessed points
- Only activate points you actually use
- Document any custom series path conventions

**❌ Don't:**

- Use generic names like "Point 1" or "Metric A"
- Mix naming conventions within a system
- Create aliases that conflict across systems
- Activate every possible point "just in case"
- Change subsystem (it's immutable for a reason)

### Series Path Design

**Hierarchical organization:**

```
source            ← Generic source
  .solar          ← Specific source type
    .local        ← Measurement location
      .power      ← Metric type
```

**Consistency patterns:**

```
source.solar.local.power     ← Local solar power measurement
source.solar.local.energy    ← Local solar energy accumulation
source.solar.remote.power    ← Remote solar power measurement
source.solar.remote.energy   ← Remote solar energy accumulation
```

**Keep it simple:**

```
✅ bidi.battery           ← Clear and simple
✅ bidi.battery.soc       ← Adds necessary detail
❌ bidi.battery.main.soc  ← Unnecessary nesting
```

### Composite Systems

**Planning:**

1. **Identify categories** - What do you want to aggregate? (solar, battery, load, grid)
2. **Find compatible points** - Use series path filtering
3. **Verify units** - All mapped points should use same units
4. **Test aggregation** - Ensure totals make sense
5. **Document mappings** - Record why points were grouped

**Common patterns:**

```json
{
  "solar": [
    "1.5", // Main house solar
    "2.3" // Guest house solar
  ],
  "battery": [
    "1.7" // Combined battery from main system
  ],
  "load": [
    "1.8", // Main house load
    "2.4" // Guest house load
  ],
  "grid": [
    "1.9" // Single grid connection point
  ]
}
```

### Data Quality

**Monitor:**

- `sample_count` in aggregated data
- `error_count` for collection failures
- `data_quality` field for anomalies
- Gaps in time series

**React to issues:**

- Check vendor API connectivity
- Verify credentials haven't expired
- Review system status in vendor portal
- Check session logs for errors

## Troubleshooting

### Point Not Appearing in UI

**Symptom:** Point exists in database but doesn't show in views

**Checks:**

1. Verify `active = 1`: `SELECT active FROM point_info WHERE system_id = X AND id = Y`
2. Check series path is not null: `SELECT type, subtype FROM point_info WHERE ...`
3. Verify system is active: `SELECT status FROM systems WHERE id = X`
4. Clear cache and refresh page

**Solution:**

```sql
-- Reactivate point
UPDATE point_info SET active = 1 WHERE system_id = X AND id = Y;
```

### Point Not Available for Composite

**Symptom:** Point doesn't appear in composite category selection

**Checks:**

1. Verify point is active
2. Check series path matches category requirements:

```sql
SELECT type, subtype, extension
FROM point_info
WHERE system_id = X AND id = Y;

-- For solar category: type should be 'source', subtype 'solar'
-- For battery: type 'bidi', subtype 'battery'
-- For load: type should be null or 'load'
-- For grid: type 'bidi', subtype 'grid'
```

**Solution:**

Edit point in Point Info modal to set correct type/subtype.

### Composite Validation Fails

**Symptom:** Error when saving composite mappings

**Common errors:**

```
"Invalid point ID format"
→ Check: Point IDs must be "systemId.pointId" with numeric values

"Point not found"
→ Check: Point exists in database and is active

"Incompatible series path"
→ Check: Point's type/subtype matches category requirements

"Point already mapped in another category"
→ Check: Remove point from other category first
```

**Debug query:**

```sql
-- Verify point details for mapping "1.5"
SELECT
  p.system_id,
  p.id,
  p.type,
  p.subtype,
  p.extension,
  p.active,
  p.display_name
FROM point_info p
WHERE p.system_id = 1 AND p.id = 5;
```

### Incorrect Data Aggregation

**Symptom:** Aggregated values don't match expected totals

**Checks:**

1. Verify transform setting:

```sql
SELECT metric_type, transform
FROM point_info
WHERE system_id = X AND id = Y;

-- Energy points should have transform = 'd'
-- Power points should have transform = null or 'n'
```

2. Check sample counts:

```sql
SELECT interval_end, sample_count, avg, delta
FROM point_readings_agg_5m
WHERE system_id = X AND point_id = Y
ORDER BY interval_end DESC
LIMIT 10;
```

3. Review raw readings:

```sql
SELECT measurement_time, value
FROM point_readings
WHERE system_id = X AND point_id = Y
ORDER BY measurement_time DESC
LIMIT 20;
```

**Solution:**

If transform is wrong, update it:

```sql
-- Fix energy point that's missing delta transform
UPDATE point_info
SET transform = 'd'
WHERE system_id = X AND id = Y AND metric_type = 'energy';
```

### Alias Conflicts

**Symptom:** Cannot save alias, get uniqueness error

**Check:**

```sql
-- Find existing point with that alias
SELECT system_id, id, display_name, alias
FROM point_info
WHERE system_id = X AND alias = 'your_alias';
```

**Solution:**

- Choose a different alias
- Or update the other point's alias first

### Missing Historical Data

**Symptom:** Point shows current value but no history

**Checks:**

1. Verify aggregation is running:

```sql
-- Check for recent aggregated data
SELECT MAX(interval_end), COUNT(*)
FROM point_readings_agg_5m
WHERE system_id = X AND point_id = Y;
```

2. Check if point was recently created:

```sql
SELECT created FROM point_info WHERE system_id = X AND id = Y;
```

3. Verify raw readings exist:

```sql
SELECT MIN(measurement_time), MAX(measurement_time), COUNT(*)
FROM point_readings
WHERE system_id = X AND point_id = Y;
```

**Solution:**

- If raw readings exist but no aggregation: Trigger manual aggregation
- If no raw readings: Check vendor adapter is collecting data
- If point is new: Wait for data collection to start

## Related Documentation

- [Database Schema](SCHEMA.md) - Complete database documentation
- [Vendor Integration](vendors/) - Vendor-specific integration guides
- [History API](HISTORY-GLOB.md) - Querying historical data
- [Daily Aggregates](DAILY_AGGREGATES.md) - Daily aggregation process
