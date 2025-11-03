# Capabilities and Composite Systems Configuration

This document describes how capabilities and composite system configurations are stored in the database and managed through APIs.

## Overview

The `systems` table contains two JSON fields for configuration:

1. **`capabilities`** - Array of enabled data capabilities (for non-composite systems)
2. **`metadata`** - Configuration object (primarily for composite systems)

## Capabilities (Non-Composite Systems)

Capabilities define which data points a system can provide. They follow a hierarchical naming scheme.

### Database Schema

**Field:** `systems.capabilities`
**Type:** `text` with `mode: "json"`
**Format:** JSON array of capability strings

```typescript
// Database schema
capabilities: text("capabilities", { mode: "json" });
```

### Capability String Format

Capabilities use dot-notation: `type.subtype.extension`

**Hierarchy:**

- **Type** (required): Top-level category
  - `bidi` - Bidirectional (battery, grid)
  - `source` - Energy sources (solar)
  - `load` - Load/consumption

- **Subtype** (required): Specific capability
  - Battery: `battery`
  - Grid: `grid`
  - Solar: `solar`
  - Load: `load`

- **Extension** (optional): Additional detail
  - Power: `power`
  - State of charge: `soc`
  - Location: `local`, `remote`

### Examples

```json
[
  "bidi.battery", // Battery bidirectional power
  "bidi.battery.power", // Battery power reading
  "bidi.battery.soc", // Battery state of charge
  "bidi.grid", // Grid bidirectional power
  "source.solar", // Total solar production
  "source.solar.local", // Local solar (from shunt/CT)
  "source.solar.remote", // Remote solar (from other inverter)
  "load" // Total load
]
```

### Default Behavior

- If `capabilities` is `null` or empty array, **all possible capabilities** for that vendor type are enabled
- Vendors define their possible capabilities via `adapter.getPossibleCapabilities(systemId)`

### API Endpoints

#### GET `/api/admin/systems/[systemId]/settings`

Retrieves system settings including capabilities.

**Response:**

```json
{
  "success": true,
  "settings": {
    "displayName": "My System",
    "shortName": "home",
    "capabilities": ["bidi.battery", "bidi.battery.soc", "source.solar", "load"]
  },
  "availableCapabilities": [
    "bidi.battery",
    "bidi.battery.soc",
    "bidi.battery.power",
    "bidi.grid",
    "source.solar",
    "source.solar.local",
    "source.solar.remote",
    "load"
  ]
}
```

#### PATCH `/api/admin/systems/[systemId]/settings`

Updates system settings including capabilities.

**Request Body:**

```json
{
  "displayName": "Updated Name", // optional
  "shortName": "new_short_name", // optional
  "capabilities": [
    // optional
    "bidi.battery",
    "bidi.battery.soc",
    "source.solar"
  ]
}
```

**Response:**

```json
{
  "success": true,
  "message": "System updated successfully",
  "system": {
    "id": 123,
    "displayName": "Updated Name",
    "shortName": "new_short_name",
    "capabilities": ["bidi.battery", "bidi.battery.soc", "source.solar"]
  }
}
```

**Validation:**

- Capabilities must be an array
- All capabilities must exist in `availableCapabilities`
- Invalid capabilities are rejected with 400 error

### UI Component

**File:** `components/CapabilitiesTab.tsx`

The Capabilities Tab displays available capabilities in a hierarchical tree:

```
☑ Bidirectional:
  ☑ battery
  ☑ grid
☑ Source:
  ☑ solar
    ☑ local
    ☑ remote
☑ Load
```

**Features:**

- Hierarchical display of capabilities
- Checkboxes only appear for actual capabilities (leaf nodes)
- Parent nodes are display-only groupings
- Dirty state tracking
- Validates against available capabilities
- Filters out invalid capabilities on load and save

## Composite Systems Configuration

Composite systems aggregate data from multiple real systems into a unified view.

### Database Schema

**Field:** `systems.metadata`
**Type:** `text` with `mode: "json"`
**Format:** JSON object with version and mappings

```typescript
// Database schema
metadata: text("metadata", { mode: "json" });
```

### Metadata Object Structure

```typescript
interface CompositeMetadata {
  version: number; // Schema version (currently 1)
  mappings: {
    solar: string[]; // Array of solar source paths (unlimited)
    battery: string[]; // Array of battery paths (max 1)
    load: string[]; // Array of load paths (unlimited)
    grid: string[]; // Array of grid paths (max 1)
  };
}
```

### Mapping Path Format

Each mapping path follows the format:

```
liveone.{systemPath}.{seriesId}
```

**System Path:**

- If system has `shortName`: use the short name directly
  - Example: `liveone.home.bidi.battery`
- If no `shortName`: use `system.{systemId}`
  - Example: `liveone.system.456.source.solar`

**Series ID:**

- The capability string from the source system
- Examples: `bidi.battery`, `source.solar`, `load`

### Complete Example

```json
{
  "version": 1,
  "mappings": {
    "solar": ["liveone.racv.source.solar", "liveone.system.789.source.solar"],
    "battery": ["liveone.home.bidi.battery"],
    "load": ["liveone.home.load", "liveone.racv.load"],
    "grid": ["liveone.home.bidi.grid"]
  }
}
```

### Constraints

- **Battery**: Maximum 1 entry
- **Grid**: Maximum 1 entry
- **Solar**: Unlimited entries
- **Load**: Unlimited entries
- All array values must be strings
- Only non-composite systems can be referenced

### API Endpoints

#### GET `/api/admin/systems/[systemId]/composite-config`

Retrieves composite configuration and available capabilities.

**Response:**

```json
{
  "success": true,
  "metadata": {
    "version": 1,
    "mappings": {
      "solar": ["liveone.home.source.solar"],
      "battery": ["liveone.home.bidi.battery"],
      "load": ["liveone.home.load"],
      "grid": ["liveone.home.bidi.grid"]
    }
  },
  "availableCapabilities": [
    {
      "systemId": 123,
      "systemName": "Home System",
      "shortName": "home",
      "seriesId": "bidi.battery",
      "label": "Battery"
    },
    {
      "systemId": 123,
      "systemName": "Home System",
      "shortName": "home",
      "seriesId": "bidi.battery.soc",
      "label": "Battery (State of Charge)"
    },
    {
      "systemId": 456,
      "systemName": "RACV System",
      "shortName": "racv",
      "seriesId": "source.solar",
      "label": "Solar"
    }
  ]
}
```

**Notes:**

- Only returns capabilities from systems owned by the same user
- Excludes the target composite system itself
- Excludes other composite systems

#### PATCH `/api/admin/systems/[systemId]/composite-config`

Updates composite system mappings.

**Request Body:**

```json
{
  "mappings": {
    "solar": ["liveone.home.source.solar", "liveone.racv.source.solar"],
    "battery": ["liveone.home.bidi.battery"],
    "load": ["liveone.home.load"],
    "grid": ["liveone.home.bidi.grid"]
  }
}
```

**Response:**

```json
{
  "success": true,
  "message": "Composite configuration updated successfully",
  "metadata": {
    "version": 1,
    "mappings": { ... }
  }
}
```

**Validation:**

- Mappings object must contain all four keys: solar, battery, load, grid
- All values must be arrays of strings
- Battery array: max 1 entry
- Grid array: max 1 entry
- Returns 400 error for invalid structure

#### GET `/api/admin/systems/composite-capabilities`

Lists all available capabilities from user's non-composite systems (used when creating new composite systems).

**Response:**

```json
{
  "success": true,
  "availableCapabilities": [
    {
      "systemId": 123,
      "systemName": "Home System",
      "shortName": "home",
      "seriesId": "bidi.battery",
      "label": "Battery"
    },
    {
      "systemId": 456,
      "systemName": "RACV System",
      "shortName": "racv",
      "seriesId": "source.solar",
      "label": "Solar"
    }
  ]
}
```

### UI Component

**File:** `components/CompositeTab.tsx`

The Composite Tab provides an interface for mapping data sources:

**Features:**

- Visual categories: Solar, Battery, Load, Grid
- Color-coded sections with icons
- Add/remove mappings per category
- Popup menu to select from available capabilities
- Grouped by source system
- Enforces max 1 for battery and grid
- Shows "one only" indicator for limited categories
- Display format: **System Name** seriesId

**Display Label Format:**

```
Home System bidi.battery
RACV System source.solar
```

## Creating Systems with Configuration

### Regular System

**Endpoint:** `POST /api/systems`

```json
{
  "vendorType": "selectronic",
  "credentials": { ... },
  "systemInfo": {
    "vendorSiteId": "12345",
    "displayName": "My System"
  }
}
```

Capabilities are automatically initialized to all available capabilities if not specified.

### Composite System

**Endpoint:** `POST /api/systems`

```json
{
  "vendorType": "composite",
  "displayName": "Combined View",
  "metadata": {
    "mappings": {
      "solar": ["liveone.home.source.solar"],
      "battery": ["liveone.home.bidi.battery"],
      "load": ["liveone.home.load"],
      "grid": ["liveone.home.bidi.grid"]
    }
  }
}
```

**Notes:**

- No credentials required for composite systems
- `vendorSiteId` is auto-generated: `composite_{timestamp}`
- Mappings are required
- Status is set to "active" by default

## System Settings Dialog Flow

**File:** `components/SystemSettingsDialog.tsx`

### Save Process

1. **General Tab** (displayName, shortName):
   - Updates via `/api/admin/systems/[systemId]/settings`

2. **Capabilities Tab** (non-composite only):
   - Gets data via `capabilitiesSaveRef.current()`
   - Included in same request as general settings
   - Updates via `/api/admin/systems/[systemId]/settings`

3. **Composite Tab** (composite only):
   - Gets data via `compositeSaveRef.current()`
   - Separate request to `/api/admin/systems/[systemId]/composite-config`

### Dirty State Tracking

Each tab tracks changes independently:

- `isNameDirty` / `isShortNameDirty` - General tab
- `isCapabilitiesDirty` - Capabilities tab
- `isCompositeDirty` - Composite tab
- `isAdminDirty` - Admin tab

Visual indicators:

- Red dot appears on tab with unsaved changes
- Save button only enabled when changes exist

### Data Flow

1. **On Open:**
   - Each tab fetches its data when `shouldLoad=true`
   - Uses refs to prevent duplicate fetches
   - Resets on close for fresh data on next open

2. **On Save:**
   - Parent calls save function refs from each dirty tab
   - Waits for async save operations
   - Refreshes page on success
   - Cache invalidation via `SystemsManager.clearInstance()`

## Best Practices

### Capabilities

1. **Always validate** against available capabilities
2. **Filter out invalid** capabilities on load
3. **Default to all** when capabilities array is empty
4. **Log warnings** when filtering invalid capabilities

### Composite Systems

1. **Enforce constraints** in API (max 1 battery/grid)
2. **Parse paths carefully** - handle both short names and system IDs
3. **Validate references** - ensure source systems exist
4. **Use shortName** when available for cleaner paths
5. **Handle legacy data** - double-encoded JSON in older records

### UI/UX

1. **Show visual hierarchy** for capabilities
2. **Group by system** in composite selection menus
3. **Clear labeling** for max entry constraints
4. **Dirty state indicators** on all tabs
5. **Validate before save** and show clear error messages

## Related Files

### Components

- `components/SystemSettingsDialog.tsx` - Main modal with tabs
- `components/CapabilitiesTab.tsx` - Capabilities configuration UI
- `components/CompositeTab.tsx` - Composite mappings UI

### API Routes

- `app/api/systems/route.ts` - Create systems (POST)
- `app/api/admin/systems/[systemId]/settings/route.ts` - Get/update settings
- `app/api/admin/systems/[systemId]/composite-config/route.ts` - Get/update composite config
- `app/api/admin/systems/composite-capabilities/route.ts` - List available capabilities

### Database

- `lib/db/schema.ts` - Schema definitions
- Table: `systems`
  - Field: `capabilities` (JSON array)
  - Field: `metadata` (JSON object)

### Utilities

- `lib/vendors/registry.ts` - Vendor adapter registry
- `lib/systems-manager.ts` - System cache management

## Troubleshooting

### Capabilities not saving

- Check that capabilities are in `availableCapabilities`
- Verify capabilities array is valid JSON
- Check console for validation errors

### Composite mappings not working

- Verify system paths use correct format
- Check that referenced systems exist and are non-composite
- Ensure battery/grid don't exceed max 1 entry
- Verify owner has access to referenced systems

### Invalid capabilities warning

- Normal when switching between vendor types
- Filter removes capabilities not available for current system
- No action needed unless capabilities disappear unexpectedly

## Migration Notes

### Version History

- **Version 1** (current):
  - Composite mappings in `metadata.mappings`
  - Support for short names in paths
  - Max 1 battery, max 1 grid constraint
