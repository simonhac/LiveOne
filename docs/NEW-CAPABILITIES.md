# Capabilities and Composite Systems Configuration

This document describes how capabilities and composite system configuration system will be revamped.

The `systems` table contains two JSON fields for configuration:

1. **`capabilities`** - Array of enabled data capabilities

we will no longer use this, so remove it from the schema.

in its place, add a field "active" to the point_info table with the value true or false.
it should be non-null, default to true. ensure that all existing pointss get set to true? (Q. is this automatic with the additon of the field, or do we need a migration?)

in the point info modal, we'll add a checkbox for "active" just above the display name.

this is quote a departure from the capabilities panel of the settings modal.
it was a settings panel, now it is just a display panel.

update it to show the points that are active.
remove the checkboxes and just show the active points in light grey, and the inactive ones in dark grey.

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
[systemId].[pointId]
```

where pointId is the Id from the points_info table.

### Complete Example

```json
{
  "version": 2,
  "mappings": {
    "solar": ["1.1", "1.2"],
    "battery": ["3.4"],
    "load": ["1.4", "1.6"],
    "grid": ["10.8"]
  }
}
```

### Constraints

- **Battery**: remove limit so that there can now be unlimited entries
- **Grid**: remove limit so that there can now be unlimited entries
- **Solar**: Unlimited entries
- **Load**: Unlimited entries
- All array values must be strings
- Only non-composite systems can be referenced

### API Endpoints

#### GET `/api/admin/systems/[systemId]/composite-config`

Retrieves the composite configuration of the given system

**Response:**

```json
{
  "success": true,
  "metadata": {
    "version": 1,
    "mappings": {
      "solar": ["1.1", "1.2"],
      "battery": ["3.4"],
      "load": ["1.4", "1.6"],
      "grid": ["10.8"]
    }
  }
}
```

**Notes:**
we no longer return the user's availablePoints -- for that use the /admin/systems/points endpoints

#### PATCH `/api/admin/systems/[systemId]/composite-config`

Updates composite system mappings.

**Request Body:**

```json
{
  "mappings": {
    "solar": ["1.1", "1.2"],
    "battery": ["3.4"],
    "load": ["1.4", "1.6"],
    "grid": ["10.8"]
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

- Mappings object can contain any number of keys. (for now most will have solar, battery, load and grid, but later we'll add more.)
- relax number of entries for battery and grid.
- Returns 400 error for invalid structure

#### GET `/api/admin/systems/points/[user]`

Lists all available capabilities from the given user's non-composite systems

**Response:**

```json
{
  "success": true,
  "availablePoints": [
    {
      "id": "1.1",
      "path": "source.solar.local",
      "name": "Solar Local"
    },
    {
      "id": "1.2",
      "path": "source.solar.remote",
      "name": "Solar Local"
    },
    {
      "id": "10.8",
      "path": "bidi.grid",
      "name": "Solar Local"
    },
    ...etc
  ],
  "referencedSystems" [
    {
      "id": 1,
      "displayName": "My Kinkora System",
      "shortName": "kinkora"
    },
    {
      "id": 10,
      "displayName": "My Farm System",
      "shortName": "Farm"
    },
    ...etc
  ]
}
```

notes:

- availablePoints is a list of all the active points from all the systems owned by the user that owns the given system
- Excludes all composite systems
- ReferencedSystems is a list of all the users that have be referenced by availablePoints (list each one only once)

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

### Composite System

**Endpoint:** `POST /api/systems`

```json
{
  "vendorType": "composite",
  "displayName": "Combined View",
  "metadata": {
    "mappings": {
      "solar": [
        "1.1",
        "1.2"
      ],
      "battery": [
        "3.4"
      ],
      "load": [
        "1.4",
        "1.6"
      ],
      "grid": [
        "10.8"
      ]
    }
}
```

**Notes:**

- No credentials required for composite systems
- `vendorSiteId` is auto-generated: `composite_{systemId}`
- Mappings are required
- Status is set to "active" by default
- when opening the system settings you'll need to GET `/api/admin/systems/points/[user]` in order to decode the pointIds in the form "1.2" to their display names and the paths.
