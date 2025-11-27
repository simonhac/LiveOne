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

| Term                  | Description                                    | Example                                  |
| --------------------- | ---------------------------------------------- | ---------------------------------------- |
| **Point**             | A single measurable value from a system        | "Battery SOC"                            |
| **System**            | A physical solar/battery installation          | "Daylesford Selectronic"                 |
| **Physical Path**     | Vendor-specific identifier using "/" separator | `selectronic/solar_w`, `E1/kwh`          |
| **Logical Path Stem** | Semantic classification using "." separator    | `source.solar`, `bidi.battery`           |
| **Logical Path**      | Full path: stem + "/" + metricType             | `source.solar/power`, `bidi.battery/soc` |
| **Metric Type**       | The kind of measurement                        | `power`, `energy`, `soc`, `temperature`  |
| **Metric Unit**       | The unit of measurement                        | `W`, `Wh`, `%`, `°C`                     |
| **Subsystem**         | Functional grouping for UI color coding        | `solar`, `battery`, `grid`, `load`       |

### Point Identity

Each point has **multiple identifiers** used in different contexts:

```typescript
// Database identity (composite primary key)
systemId: 1;
index: 5; // Sequential per system (DB column "id", TS property "index")

// Physical path (vendor identity, unique within system)
physicalPath: "selectronic/solar_w"; // Vendor-specific, "/" separator

// Logical path (semantic identity)
logicalPathStem: "source.solar"; // Semantic classification, "." separator
metricType: "power"; // Measurement type
// Full logicalPath = "source.solar/power"

// Display
defaultName: "Solar"; // From vendor (immutable)
displayName: "Main Solar Power"; // User-editable
subsystem: "solar"; // For UI grouping/colors
```

### Logical Paths

Logical paths provide semantic identification for points, enabling categorization and composite system mappings.

**Structure:**

```
logicalPathStem / metricType
└─────┬──────┘   └────┬────┘
 "." separated    measurement
```

**Examples:**

| Logical Path Stem     | Metric Type | Full Logical Path            | Description             |
| --------------------- | ----------- | ---------------------------- | ----------------------- |
| `source.solar`        | `power`     | `source.solar/power`         | Total solar power       |
| `source.solar.local`  | `power`     | `source.solar.local/power`   | Local solar CT          |
| `source.solar.remote` | `energy`    | `source.solar.remote/energy` | Remote inverter energy  |
| `bidi.battery`        | `power`     | `bidi.battery/power`         | Battery power           |
| `bidi.battery`        | `soc`       | `bidi.battery/soc`           | Battery state of charge |
| `bidi.grid`           | `power`     | `bidi.grid/power`            | Grid power              |
| `load`                | `power`     | `load/power`                 | Total load              |

**Path Rules:**

- `logicalPathStem` uses "." as segment separator
- Full logical path = `stem + "/" + metricType`
- Stem can be null for points without semantic classification
- Path determines composite category eligibility

### Physical vs Logical Paths

| Field               | Separator | Set By         | Purpose                               | Example               |
| ------------------- | --------- | -------------- | ------------------------------------- | --------------------- |
| **physicalPath**    | `/`       | Vendor adapter | Vendor-specific identifier            | `selectronic/solar_w` |
| **logicalPathStem** | `.`       | Vendor adapter | Semantic classification               | `source.solar`        |
| **logicalPath**     | `.` + `/` | Computed       | Full semantic path for categorization | `source.solar/power`  |

**Physical path** is the vendor's identifier - used internally for data collection and deduplication.

**Logical path** is the semantic identifier - used for UI categorization, composite mappings, and API queries.

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
  id INTEGER NOT NULL,                     -- Sequential per system (TS: "index")

  -- Paths
  physical_path TEXT NOT NULL,             -- Vendor-specific, "/" separator
  logical_path_stem TEXT,                  -- Semantic classification, "." separator (nullable)

  -- Metric information
  metric_type TEXT NOT NULL,               -- power, energy, soc, etc.
  metric_unit TEXT NOT NULL,               -- W, Wh, %, etc.

  -- Display information
  point_name TEXT NOT NULL,                -- Default name from vendor
  display_name TEXT NOT NULL,              -- User-editable display name
  subsystem TEXT,                          -- For UI grouping: solar, battery, grid, load, etc.

  -- Configuration
  transform TEXT,                          -- null = none, 'i' = invert, 'd' = differentiate
  active INTEGER NOT NULL DEFAULT 1,       -- Boolean: 1 = enabled, 0 = disabled

  -- Timestamps (milliseconds)
  created_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER,

  PRIMARY KEY (system_id, id),
  UNIQUE (system_id, physical_path),
  UNIQUE (system_id, logical_path_stem, metric_type)
);
```

**Key Constraints:**

1. **Composite Primary Key**: `(system_id, id)` - Points are numbered sequentially per system
2. **Physical Path Uniqueness**: `(system_id, physical_path)` - Each vendor path maps to one point
3. **Logical Path Uniqueness**: `(system_id, logical_path_stem, metric_type)` - Full logical path is unique

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
      physicalPath: "selectronic/solar_w",
      logicalPathStem: "source.solar",
      metricType: "power",
      metricUnit: "W",
      defaultName: "Solar",
      subsystem: "solar",
      transform: null,
    },
    {
      physicalPath: "selectronic/battery_soc",
      logicalPathStem: "bidi.battery",
      metricType: "soc",
      metricUnit: "%",
      defaultName: "Battery SOC",
      subsystem: "battery",
      transform: null,
    },
    // ... more points
  ];
}
```

**Point Manager** creates points in the database:

```typescript
// lib/point/point-manager.ts
await pointManager.ensurePointInfo(systemId, pointMetadata);
```

This:

1. Checks if point exists by `(system_id, physical_path)`
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

### Logical Path Stem

The semantic classification of a point:

```sql
logical_path_stem TEXT  -- "." separated, nullable
```

**Rules:**

- Nullable (points without semantic classification)
- Uses "." as segment separator
- Combined with `metric_type` to form full logical path
- Determines composite category eligibility

**Common patterns:**

| Logical Path Stem     | Description                   |
| --------------------- | ----------------------------- |
| `source.solar`        | Total solar                   |
| `source.solar.local`  | Local solar CT measurement    |
| `source.solar.remote` | Remote inverter               |
| `bidi.battery`        | Battery (bidirectional)       |
| `bidi.battery.charge` | Battery charging specifically |
| `bidi.grid`           | Grid (bidirectional)          |
| `load`                | Total load                    |
| `load.critical`       | Critical loads                |

**Stem segment conventions:**

- First segment: flow type (`source`, `bidi`, `load`)
- Second segment: equipment (`solar`, `battery`, `grid`)
- Additional segments: qualifiers (`local`, `remote`, `charge`, etc.)

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

| Field        | Control    | Validation                            |
| ------------ | ---------- | ------------------------------------- |
| Active       | Checkbox   | Required boolean                      |
| Display Name | Text input | Required, non-empty                   |
| Transform    | Dropdown   | `n` (none), `d` (delta), `i` (invert) |

**Read-Only Fields:**

- Default Name (from vendor)
- Physical Path
- Logical Path (stem + "/" + metricType)
- Subsystem
- Metric Type
- Metric Unit

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
│ source.solar/power                       │
│   • Solar Power (2500 W)                 │
│ source.solar.local/power                 │
│   • Local Solar (1500 W)                 │
│ source.solar.remote/power                │
│   • Remote Solar (1000 W)                │
└──────────────────────────────────────────┘

┌─ Battery ───────────────────────────────┐
│ bidi.battery/power                       │
│   • Battery Power (-700 W)               │
│ bidi.battery/soc                         │
│   • Battery SOC (85.5 %)                 │
└──────────────────────────────────────────┘
```

**Features:**

- Grouped by subsystem (solar, battery, grid, load, inverter, other)
- Color-coded subsystem panels
- Shows full logical path (stem/metricType)
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

Returns all active points with logical paths from a user's non-composite systems.

**Parameters:**

- `[userId]` - Clerk user ID

**Response:**

```json
{
  "success": true,
  "availablePoints": [
    {
      "id": "1.5",
      "logicalPath": "bidi.battery/soc",
      "pointName": "Battery SOC",
      "systemId": 1,
      "systemName": "Daylesford Selectronic"
    }
  ],
  "referencedSystems": [
    {
      "id": 1,
      "displayName": "Daylesford Selectronic",
      "alias": "daylesford"
    }
  ]
}
```

- `id` - Point reference in format "systemId.pointIndex"
- `logicalPath` - Full logical path (stem + "/" + metricType)
- `pointName` - Display name (user-set or default)
- `referencedSystems` - Systems that have at least one point in availablePoints
- `alias` is only included if non-null

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

1. **Define point metadata** - Specify physicalPath, logicalPathStem, metric type, etc.
2. **Create points** - Ensure points exist before writing data
3. **Write readings** - Store measurements in point_readings
4. **Handle errors** - Track and report collection failures

**Example: Amber Electric**

```typescript
// lib/vendors/amber/point-metadata.ts
export function getAmberPoints(): PointMetadata[] {
  return [
    {
      physicalPath: "E1/kwh", // Vendor-specific path
      logicalPathStem: "bidi.grid", // Semantic classification
      metricType: "energy",
      metricUnit: "Wh",
      defaultName: "Grid Import",
      subsystem: "grid",
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
- Use consistent logical path stem conventions across similar systems
- Only activate points you actually use
- Document any custom path conventions

**❌ Don't:**

- Use generic names like "Point 1" or "Metric A"
- Mix naming conventions within a system
- Activate every possible point "just in case"

### Logical Path Design

**Hierarchical organization:**

```
source            ← Flow type (generation)
  .solar          ← Equipment type
    .local        ← Qualifier
```

Full logical path adds metric type: `source.solar.local/power`

**Consistency patterns:**

```
source.solar.local/power     ← Local solar power measurement
source.solar.local/energy    ← Local solar energy accumulation
source.solar.remote/power    ← Remote solar power measurement
source.solar.remote/energy   ← Remote solar energy accumulation
```

**Keep it simple:**

```
✅ bidi.battery/power     ← Clear and simple
✅ bidi.battery/soc       ← Different metric type
❌ bidi.battery.main/soc  ← Unnecessary nesting
```

### Composite Systems

**Planning:**

1. **Identify categories** - What do you want to aggregate? (solar, battery, load, grid)
2. **Find compatible points** - Use logical path filtering
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
2. Check logical path stem is not null: `SELECT logical_path_stem FROM point_info WHERE system_id = X AND id = Y`
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
2. Check logical path stem matches category requirements:

```sql
SELECT logical_path_stem, metric_type
FROM point_info
WHERE system_id = X AND id = Y;

-- For solar category: logical_path_stem should start with 'source.solar'
-- For battery: logical_path_stem should start with 'bidi.battery'
-- For load: logical_path_stem should be 'load' or start with 'load.'
-- For grid: logical_path_stem should start with 'bidi.grid'
```

**Solution:**

Edit point in Point Info modal to set the correct logical path stem.

### Composite Validation Fails

**Symptom:** Error when saving composite mappings

**Common errors:**

```
"Invalid point ID format"
→ Check: Point IDs must be "systemId.pointId" with numeric values

"Point not found"
→ Check: Point exists in database and is active

"Incompatible logical path"
→ Check: Point's logical path stem matches category requirements

"Point already mapped in another category"
→ Check: Remove point from other category first
```

**Debug query:**

```sql
-- Verify point details for mapping "1.5"
SELECT
  p.system_id,
  p.id,
  p.logical_path_stem,
  p.metric_type,
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
SELECT created_at_ms FROM point_info WHERE system_id = X AND id = Y;
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
