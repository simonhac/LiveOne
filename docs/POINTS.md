# Points System Documentation

This document describes the Points system - how monitoring points are configured, organized, and used throughout the application.

## Overview

The Points system replaces the old capabilities-based approach with a more flexible point-level configuration. Each system has multiple monitoring points (e.g., "Battery SOC", "Solar Power", "Grid Import"), and each point can be individually configured and enabled/disabled.

## Database Schema

### Point Info Table

**Table:** `point_info`
**Primary Key:** Composite `(system_id, id)`

```sql
CREATE TABLE point_info (
  -- Composite primary key
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,  -- Sequential per system

  -- Identification from vendor
  point_id TEXT NOT NULL,      -- e.g., "5ecacac2-3cc3-447a-b3b5-423e333031e6"
  point_sub_id TEXT,           -- e.g., "energyNowW"

  -- Display names
  default_name TEXT NOT NULL,  -- From device, e.g., "Battery"
  display_name TEXT NOT NULL,  -- User-editable display name
  short_name TEXT,             -- Optional short identifier (alphanumeric + underscore)

  -- Series ID components (hierarchical path)
  subsystem TEXT,    -- e.g., "solar", "battery", "grid" (set at init, not editable)
  type TEXT,         -- e.g., "source", "load", "bidi" (user editable)
  subtype TEXT,      -- e.g., "solar", "battery", "grid" (user editable)
  extension TEXT,    -- e.g., "local", "remote", "power", "soc" (user editable)

  -- Configuration
  active INTEGER NOT NULL DEFAULT 1,  -- Boolean: whether point is enabled

  -- Metric information
  metric_type TEXT NOT NULL,   -- e.g., "power", "energy", "soc"
  metric_unit TEXT NOT NULL,   -- e.g., "W", "Wh", "%"

  PRIMARY KEY (system_id, id),
  UNIQUE (system_id, point_id, point_sub_id),
  UNIQUE (system_id, short_name) WHERE short_name IS NOT NULL
);
```

### Related Tables

- **`point_readings`** - Time-series data for points
- **`point_readings_agg_5m`** - 5-minute aggregated data

## Series ID Format

Points use a hierarchical dot-notation path for identification:

```
type.subtype.extension
```

### Hierarchy

1. **Type** (optional, user-editable):
   - `source` - Energy sources (solar)
   - `bidi` - Bidirectional (battery, grid)
   - `load` - Consumption

2. **Subtype** (optional, user-editable):
   - `solar` - Solar generation
   - `battery` - Battery storage
   - `grid` - Grid connection
   - Custom values allowed

3. **Extension** (optional, user-editable):
   - `power` - Power measurement
   - `soc` - State of charge
   - `local` - Local measurement
   - `remote` - Remote measurement
   - Custom values allowed

### Examples

```
source.solar          // Total solar production
source.solar.local    // Local solar (from CT)
source.solar.remote   // Remote solar (from other inverter)
bidi.battery          // Battery power (bidirectional)
bidi.battery.soc      // Battery state of charge
bidi.grid             // Grid power (bidirectional)
load                  // Total load
```

## Point Configuration

### Active Flag

Each point has an `active` boolean field (default: `true`) that determines whether it's enabled:

- **Active points** (`active = true`): Included in data queries, composite mappings, and displays
- **Inactive points** (`active = false`): Hidden from most views, excluded from composites

This replaces the old system-level `capabilities` field with per-point granularity.

### Point Info Modal

**File:** `components/PointInfoModal.tsx`

The Point Info Modal allows editing individual point configuration:

**Editable Fields:**

- **Active** - Checkbox to enable/disable the point
- **Display Name** - User-friendly name
- **Short Name** - Optional identifier for URLs/IDs
- **Type** - Top-level category (dropdown)
- **Subtype** - Subcategory (free text)
- **Extension** - Additional qualifier (free text)

**Read-only Fields:**

- Default Name (from device)
- Subsystem (set at initialization)
- Metric Type/Unit
- Point ID

**API Endpoint:** `PATCH /api/admin/points/[pointId]`

```json
{
  "active": true,
  "displayName": "Battery State of Charge",
  "shortName": "batt_soc",
  "type": "bidi",
  "subtype": "battery",
  "extension": "soc"
}
```

### Capabilities Tab (Read-Only Display)

**File:** `components/CapabilitiesTab.tsx`

The Capabilities Tab shows all points grouped by subsystem in a read-only panel view:

**Features:**

- **Subsystem Panels**: Solar, Battery, Grid, Load, Inverter, Other
- **Color-coded**: Each subsystem has distinct icon and color
- **Hierarchical Tree**: Points organized by type → subtype → extension → metric
- **Active/Inactive Styling**:
  - Active points: Light grey text
  - Inactive points: Dark grey text, lower opacity
- **Read-only**: No checkboxes, just display

**Example Display:**

```
┌─ Solar ─────────────────────────┐
│ source                           │
│   solar                          │
│     • power                      │
│     • local                      │
│       • power                    │
└──────────────────────────────────┘
```

### View Data Modal

**File:** `components/ViewDataModal.tsx`

When viewing system data, inactive points are shown with:

- Strikethrough text
- Reduced opacity (60%)
- Still visible but clearly distinguished from active points

## Composite System Mappings

Composite systems aggregate data from multiple source systems using point IDs.

### Mapping Format

**Version 2** mappings use the format: `{systemId}.{pointId}`

```typescript
interface CompositeMetadata {
  version: 2;
  mappings: {
    solar: string[]; // e.g., ["1.5", "10.3"]
    battery: string[]; // e.g., ["1.7"]
    load: string[]; // e.g., ["1.8", "10.6"]
    grid: string[]; // e.g., ["1.9"]
    // Future categories can be added
  };
}
```

### Example

```json
{
  "version": 2,
  "mappings": {
    "solar": ["1.1", "1.2", "10.3"],
    "battery": ["1.4", "1.5"],
    "load": ["1.6"],
    "grid": ["1.7"]
  }
}
```

### Category Path Requirements

Each category only accepts points with compatible series ID paths:

- **solar**: `source.solar` or `source.solar.*`
- **battery**: `bidi.battery` or `bidi.battery.*`
- **load**: `load` or `load.*`
- **grid**: `bidi.grid` or `bidi.grid.*`

Both frontend and backend validate these constraints.

### Composite Tab UI

**File:** `components/CompositeTab.tsx`

**Features:**

- **Category panels**: Solar, Battery, Load, Grid with color-coded icons
- **Add button**: Opens popup menu with available points
- **Point selection**:
  - Grouped by source system
  - Alphabetically sorted (systems and points)
  - Shows point name and path (e.g., "Battery SOC bidi.battery.soc")
  - Only shows compatible points for each category
- **Display format**: **System Name** Point Name
- **Remove button**: X icon to remove mapping

**Example Display:**

```
┌─ Battery ──────────────────────┐
│  Daylesford Selectronic Battery│
│  Kinkora Mondo Battery SOC     │
│                       [+ Add]  │
└────────────────────────────────┘
```

## API Endpoints

### Get System Points

**Endpoint:** `GET /api/admin/systems/points/[user]`

Returns all active points from a user's non-composite systems.

**Parameters:**

- `[user]` - User identifier (e.g., "me" for current user, or clerk user ID)

**Response:**

```json
{
  "success": true,
  "availablePoints": [
    {
      "id": "1.1",
      "path": "source.solar",
      "name": "Solar Power",
      "systemId": 1,
      "systemName": "Daylesford Selectronic"
    },
    {
      "id": "1.2",
      "path": "bidi.battery.soc",
      "name": "Battery SOC",
      "systemId": 1,
      "systemName": "Daylesford Selectronic"
    }
  ],
  "referencedSystems": [
    {
      "id": 1,
      "displayName": "Daylesford Selectronic",
      "shortName": "daylesford"
    }
  ]
}
```

### Update Point Configuration

**Endpoint:** `PATCH /api/admin/points/[pointId]`

Updates configuration for a specific point.

**Request Body:**

```json
{
  "active": true,
  "displayName": "Battery State of Charge",
  "shortName": "batt_soc",
  "type": "bidi",
  "subtype": "battery",
  "extension": "soc"
}
```

**Notes:**

- `active` is required (boolean)
- All other fields are optional
- Validates short name format (alphanumeric + underscore only)
- Ensures short name uniqueness within system

**Response:**

```json
{
  "success": true,
  "message": "Point updated successfully",
  "point": {
    "pointDbId": 123,
    "systemId": 1,
    "pointId": "abc-123",
    "displayName": "Battery State of Charge",
    "shortName": "batt_soc",
    "active": true,
    "type": "bidi",
    "subtype": "battery",
    "extension": "soc"
  }
}
```

### Get/Update Composite Configuration

**Endpoint:** `GET /api/admin/systems/[systemId]/composite-config`

Returns composite system configuration.

**Response:**

```json
{
  "success": true,
  "metadata": {
    "version": 2,
    "mappings": {
      "solar": ["1.1", "1.2"],
      "battery": ["1.4"],
      "load": ["1.6"],
      "grid": ["1.7"]
    }
  }
}
```

**Endpoint:** `PATCH /api/admin/systems/[systemId]/composite-config`

Updates composite system mappings with validation.

**Request Body:**

```json
{
  "mappings": {
    "solar": ["1.1", "1.2"],
    "battery": ["1.4"],
    "load": ["1.6"],
    "grid": ["1.7"]
  }
}
```

**Validation:**

- All mapping values must be arrays of strings
- Point IDs must be in format `"systemId.pointId"` with numeric components
- Points must exist in database
- Points must have compatible paths for their category
- Returns detailed error messages for validation failures

## System Settings Dialog

**File:** `components/SystemSettingsDialog.tsx`

### Tabs

1. **General** - Display name, short name
2. **Capabilities** - Read-only view of points (non-composite only)
3. **Composite** - Composite mappings (composite systems only)
4. **Admin** - Admin-only settings (if user is admin)

### Save Process

**General + Capabilities:**

- Single PATCH to `/api/admin/systems/[systemId]/settings`
- Only saves `displayName` and `shortName` (capabilities removed)

**Composite:**

- Separate PATCH to `/api/admin/systems/[systemId]/composite-config`
- Validates all mappings before saving

### Dirty State Tracking

Each tab tracks changes independently:

- `isNameDirty` / `isShortNameDirty` - General tab changes
- `isCompositeDirty` - Composite tab changes
- `isAdminDirty` - Admin tab changes

Visual indicators:

- Red dot on tab with unsaved changes
- Save button enabled only when changes exist

## Migration from Old System

### Database Migration

**Migration:** `0021_remove_capabilities_add_point_active.sql`

Changes:

1. Add `active` field to `point_info` table (default `true`)
2. Set all existing points to `active = true`
3. Remove `capabilities` field from `systems` table

### Breaking Changes

- `systems.capabilities` field removed
- Capabilities are now managed at point level via `point_info.active`
- Old composite mapping format (version 1) no longer supported
- Composite mappings now use `{systemId}.{pointId}` instead of `liveone.{systemPath}.{seriesId}`

## Best Practices

### Point Configuration

1. **Use descriptive display names** - Help users identify points easily
2. **Set type/subtype/extension consistently** - Enables proper categorization
3. **Use short names for frequently accessed points** - Better URLs and API IDs
4. **Only activate points you need** - Reduces clutter in views

### Composite Systems

1. **Validate point compatibility** - Only map points with compatible paths
2. **Use meaningful category names** - Solar, Battery, Load, Grid are standard
3. **Document mappings** - Use display names that make the source clear
4. **Test composite views** - Verify data aggregates correctly

### UI/UX

1. **Show subsystem grouping** - Makes point organization clear
2. **Visual distinction for active/inactive** - Users can see what's enabled
3. **Alphabetical sorting** - Easier to find specific points
4. **Clear error messages** - Help users fix validation issues

## Troubleshooting

### Point not appearing in composite menu

- Check that point's `active` field is `true`
- Verify point has a valid series ID path (type is not null)
- Ensure point's path matches category requirements

### Composite mapping validation fails

- Verify point ID format is `"systemId.pointId"` with numeric values
- Check that point exists in database
- Ensure point's series ID path matches category (e.g., battery category requires `bidi.battery` path)

### Point appears in wrong category

- Check the `type` and `subtype` fields in Point Info Modal
- Categories are based on the series ID path, not subsystem
- Update type/subtype to match desired category

## Related Files

### Components

- `components/PointInfoModal.tsx` - Individual point configuration
- `components/CapabilitiesTab.tsx` - Read-only points display
- `components/CompositeTab.tsx` - Composite mappings UI
- `components/ViewDataModal.tsx` - Data view with active/inactive display
- `components/SystemSettingsDialog.tsx` - Main settings dialog

### API Routes

- `app/api/admin/points/[pointId]/route.ts` - Update point configuration
- `app/api/admin/systems/points/[user]/route.ts` - List user's points
- `app/api/admin/systems/[systemId]/composite-config/route.ts` - Composite configuration
- `app/api/admin/systems/[systemId]/settings/route.ts` - System settings (no longer handles capabilities)

### Database

- `lib/db/schema-monitoring-points.ts` - Point tables schema
- `migrations/0021_remove_capabilities_add_point_active.sql` - Migration adding active field

### Utilities

- `lib/history/point-readings-provider.ts` - Filters by active flag when querying data
