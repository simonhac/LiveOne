# LiveOne Project History

A chronological record of major features, APIs, subsystems, migrations, and architectural changes in the LiveOne solar monitoring platform.

---

# August 2025

## 16 August 2025

### Initial Project Foundation

- **Core application structure**: Next.js app with TypeScript, Tailwind CSS
- **Database**: SQLite with Drizzle ORM
- **Authentication**: Session-based authentication system
- **Real-time updates**: Server-Sent Events (SSE) implementation

### Database Schema (Initial)

- `systems` table: Inverter system information
- `readings` table: Time-series power/energy data with dual timestamps (inverter_time, received_at)
- `hourly_aggregates` table: Pre-aggregated hourly statistics
- `polling_status` table: Track polling state per system

### Core Features

- **Dashboard**: Real-time power monitoring with cards for solar, load, battery, grid
- **Admin page**: System management interface
- **Background polling**: 1-minute interval data collection from Selectronic API
- **Dual solar tracking**: Remote and local solar sources
- **Energy statistics**: Daily and all-time energy totals
- **Fault detection**: Alert system for inverter faults

### API Routes

- `/api/data` - Current system data
- `/api/sse` - Server-sent events stream for real-time updates
- `/api/admin/systems` - System management CRUD
- `/api/polling/start` - Manual polling trigger

### Historical Data System

- `/api/history` - Time-series data in OpenNEM format
- **EnergyChart component**: Recharts-based visualization with multiple time periods (1D, 7D, 30D)
- **5-minute aggregation**: Performance optimization for historical queries
- **Integration tests**: Test suite for history API

## 17 August 2025

### Cloud Migration

- **Turso database**: Migrated from local SQLite to Turso (edge-hosted libSQL)
- **Tokyo region**: Deployed database in AWS Tokyo for Australia performance
- **Vercel deployment**: Serverless architecture with environment variables

### Infrastructure Changes

- **Cron-based polling**: Vercel Cron job `/api/cron/poll-systems` replaces local background polling
- **Cleanup cron**: `/api/cron/cleanup` for data retention
- **Production safeguards**: Environment-based configuration
- **Font optimization**: Local font loading for performance

### Performance Improvements

- **5-minute aggregation table** (`readings_agg_5m`): Pre-aggregated data for 4x faster queries
- **Unique constraints**: Prevent duplicate timestamps
- **Automatic aggregation**: Real-time as data arrives

### Schema Changes

- **Migration**: Text timestamps converted to Unix integer timestamps
- **New column**: `last_response` in `polling_status` to store full Select.Live response
- **readings_agg_5m table**: system_id, interval_start, interval_end, solar_w_avg, load_w_avg, etc.

## 18 August 2025

### Daily Aggregation System

- **readings_agg_daily table**: Daily statistics for long-term performance
- **Daily cron job**: `/api/cron/daily` runs at 00:05 AEST
- **Catchup mode**: Backfill historical aggregates
- **Clear mode**: Regenerate all daily aggregates
- **Timezone support**: Accurate daily boundaries with UTC offset

### Documentation

- **SCHEMA.md**: Comprehensive database schema documentation
- **CLAUDE.md**: Development workflow and guidelines
- **API.md**: API endpoint documentation

### UI Enhancements

- **Yesterday energy**: Added to dashboard
- **Power/Energy toggle**: Switch chart modes
- **7-day chart**: X-axis with day names
- **Improved tooltips**: Better data presentation

### Cleanup

- Removed old polling system code
- Renamed API endpoints for clarity
- Environment-variable based admin auth
- Vercel build log retrieval script

## 20–23 August 2025

### Chart & UX Improvements

- **Timezone fixes**: Correct date calculations for AEST
- **Gap filling**: Null value handling in time series
- **Energy charts**: Bar charts for daily energy totals
- **Custom tooltips**: Inline chart tooltips with better formatting
- **Mobile layout**: Responsive design optimizations
- **Hamburger menu**: Mobile navigation
- **PeriodSwitcher**: Reusable component for time period selection
- **Typography**: DM Sans font, non-breaking spaces between values and units

## 30 August 2025

### Multi-Vendor Architecture Refactor

- **System identification**: Changed from `system_number` to `vendor_type` + `vendor_site_id`
- **Vendor abstraction**: Prepared codebase for multiple vendor integrations

### Schema Changes

- **Migration**: Renamed `system_number` to `vendor_site_id`
- **New column**: `vendor_type` in systems table

### Authentication Migration

- **Clerk integration**: Migrated from session-based to Clerk authentication
- **OAuth support**: Social login capabilities
- **User management**: Simplified role management
- **Removed**: Legacy session authentication code
- **Removed**: `/setup` route

### Project Reorganization

- Test structure improvements
- Removed obsolete Drizzle migrations
- Moved scripts to `/tools` directory
- Root directory cleanup

## 31 August – 5 September 2025

### Enphase Integration (Multi-Vendor Support)

- **OAuth flow**: Enphase authentication system
- **API client**: Enphase API integration with proxy endpoint
- **Test connection**: Modal for validating Enphase credentials
- **System creation**: Import systems from Enphase account
- **Credential storage**: OAuth token management

### Schema Changes

- **enphase_credentials table**: Store OAuth tokens and API keys
- **systems table**: Support for Enphase vendor type

### Enphase-Specific Features

- **Summary endpoint**: Real-time production data
- **Smart polling**: Sunrise/sunset awareness using suncalc library
- **30-minute intervals**: 1-day view optimization
- **Historical sync**: Backfill historical data
- **Yesterday data**: Gap-filling for incomplete days
- **Flexible dates**: Parameterized historical fetching

### UI Components

- **Settings dropdown**: Test connection and system settings
- **JSON viewer**: Raw API response inspection
- **Connection status**: Error handling and display
- **Admin improvements**: Better access controls

### Documentation

- Comprehensive Enphase integration guide
- Enphase API documentation
- Testing procedures

---

# September 2025

## 8–9 September 2025

### Enphase Module Cleanup

- **Refactored**: Enphase proxy logic into clean fetch wrapper
- **Daily aggregation**: Enphase systems support for daily stats
- **Fault display**: Fixed warning presentation
- **API cleanup**: Removed success parameter from responses

### Third Vendor: craighack

- **Custom vendor**: Special-purpose integration
- **History API**: `getSystemHistoryInOpenNEMFormatHack` implementation
- **Improved logging**: Better system validation

### Developer Tools

- **Script organization**: Separated temp vs utils directories
- **Test token generator**: `/scripts/utils/get-test-token.ts` for API testing
- **Production auth**: Bearer token support

## 10–12 September 2025

### Database Sync System

- **Admin feature**: Database sync modal with progress tracking
- **Stage-level reporting**: Detailed sync progress
- **DRY refactoring**: Reduced code duplication
- **URL parameters**: Chart period support in URLs

### UI Improvements

- **Dev indicator**: Orange bar for development environment
- **Window title**: "Dev" suffix in development
- **Session timeout**: User-friendly modal for expired sessions
- **Error handling**: JSON parse errors for invalid tokens

## 21–23 September 2025

### Vendor Adapter Architecture

- **VendorAdapter interface**: Unified vendor integration pattern
- **Base adapter class**: Common functionality shared across vendors
- **Vendor registry**: Dynamic vendor management
- **Improved fault handling**: Consistent error reporting

### Fourth Vendor: Fronius

- **Push endpoint**: `/api/fronius/push` for inverter data
- **Push-only systems**: Skip polling for push-based vendors

### Performance Optimization

- **Clerk optimization**: Session claims for faster auth
- **Raw JSON storage**: Vendor responses cached in database
- **Reduced API calls**: Better caching strategy

### Schema Changes

- **vendor_responses table**: Store raw API responses
- **systems table**: `is_push_only` flag

## 27–28 September 2025

### Session Tracking System

- **sessions table**: Track all polling attempts with timestamps
- **Session ID pattern**: Deployment and environment tracking (e.g., `20240927-1234-prod-abc123`)
- **Polling statistics**: Admin modal showing session details
- **Activity viewer**: Detailed session information

### Schema Changes

- **Migration**: Created `sessions` table with id, system_id, vendor_type, started_at, completed_at, status, error_message
- **readings table**: Added `session_id` foreign key
- **Removed**: `pointGroups` table (migrated to systems)
- **Removed**: `measurement_sessions` table

### Critical Production Fix

- **URGENT deployment**: Added missing sessions table to production
- **Dashboard access**: Fixed permissions for owned systems

---

# October 2025

## 1–4 October 2025

### Multi-Point Systems (Mondo Vendor)

- **point_readings table**: Flexible metrics for systems with multiple monitoring points
- **Mondo integration**: Fifth vendor supporting complex monitoring
- **Point-based dashboard**: Display metrics from multiple points
- **Monitoring points viewer**: Admin interface for point data

### Schema Changes

- **Migration**: Created `point_readings` table with system_id, point_id, point_sub_id, inverter_time, metric_name, value
- **point_info table**: Metadata for monitoring points

### Features

- **Test connection**: Mondo system validation
- **Point readings API**: Optimized queries for point data
- **Polling schedule**: Vendor-specific polling intervals
- **Session ID singleton**: Unique deployment labeling
- **API duration tracking**: Performance monitoring

### Performance

- Fixed duplicate fetch issues
- Polling interval cache

## 12 October 2025

### History API Refactor

- **MeasurementSeries**: Cleaner data structure for time-series
- `/api/history-new`: Redesigned endpoint with better architecture
- **Dashboard migration**: Switched to new endpoint
- **Critical bug fix**: Data alignment in OpenNEM converter

### Point Readings Aggregation

- **point_readings_agg_5m table**: Optimized 5-minute aggregates for point data
- **Backfill migration**: Historical data aggregation
- **Database sync**: Integrated point aggregation into sync workflow

### Schema Changes

- **Migration**: Created `point_readings_agg_5m` with composite keys and optimized indexes
- **Removed**: Deprecated `/api/history` endpoint

### UI Enhancements

- **Point info editor**: Admin data modal improvements
- **Combined charts**: Stacked area charts for Mondo systems
- **Timezone-aware**: Tooltips with correct timezone display

## 13–16 October 2025

### URL-Friendly System Identification

- **shortName field**: Optional human-readable system identifiers
- **Point shortName**: Point-level identifiers
- **URL format**: username/shortname paths
- **History API**: Uses shortNames in series IDs

### Schema Changes

- **Migration**: Added `shortName` to systems and point_info tables

### Mondo Power Charts Enhancement

- **Improved colors**: Better chart design
- **Power tables**: Aligned columns for readability
- **Red cursor**: Vertical hairline for precision
- **Centralized fetching**: Faster data loading
- **Responsive design**: Mobile optimizations
- **Energy calculations**: Derived metrics

## 19–25 October 2025

### Mobile UX Improvements

- **Fixed time windows**: Consistent chart periods
- **Touch events**: Mobile-friendly interactions
- **Long press toggle**: Better mobile controls
- **Chart hover**: Improved mobile experience

### Code Quality

- **ESLint**: Pre-commit hook with Husky
- **Prettier**: Automated code formatting
- **lint-staged**: Only format changed files

## 30–31 October 2025

### Point Taxonomy System

- **Type/subtype/extension**: Structured point categorization
- **Label field**: History API improvements
- **Multi-row header**: ViewData modal enhancements
- **Extras toggle**: Optional field visibility

### Schema Changes

- **Migration**: Added taxonomy fields to point_info (type, subtype, extension, label)

### System Management Improvements

- **Vendor naming**: Standardized display names
- **Settings UX**: Improved user experience
- **Capabilities tab**: Show available point paths
- **Admin tab**: Ownership and viewer management
- **Unique shortnames**: Globally unique system identifiers

---

# November 2025

## 1–4 November 2025

### Composite Systems Architecture

- **Composite systems**: Combine multiple source systems into unified view
- **MondoPowerChart**: Layout for composite visualization
- **Series suffixes**: `.avg`, `.min`, `.max` for aggregated data
- **Admin management**: Ownership and viewer controls
- **Unconfigured warnings**: Alert for missing composite configuration

### Schema Changes

- **Migration 0016 (CRITICAL FAILURE)**: Attempted composite primary keys migration
  - **Data loss**: 345,456 point_readings lost
  - **Root cause**: No validation before DROP TABLE
  - **Recovery**: 8+ hour restoration from backup
  - **Lesson**: Always validate row counts before destructive operations
- **Migration 0017 (Successful)**: Composite primary keys with proper validation
  - Changed point tables from auto-increment id to composite (system_id, point_id, inverter_time)
  - Added standalone time indexes
  - Proper transaction with row count validation
- **composite_mappings table**: Configuration for composite system sources
- **systems table**: Renamed `name` → `displayName`
- **shortName**: Changed to per-user unique (not globally unique)

### Point Architecture

- **Raw SQL client**: Complex queries beyond Drizzle
- **Point-level active flags**: Disable individual points
- **Session tracking**: Point readings linked to sessions

### Database Improvements

- **6-hour sync period**: Option for large syncs
- **Session display**: UI shows session labels
- **Raw/5m toggle**: View Data modal enhancements
- **Cursor pagination**: Fixed edge cases

## 5–8 November 2025

### Historical Navigation

- **Chart time navigation**: Navigate historical time periods
- **URL date encoding**: Shareable historical chart URLs
- **Period parameters**: start/end date support
- **Interval calculation**: Reusable helper utilities
- **Period switcher**: Triggers data refetch

### Energy Flow Visualization

- **EnergyFlowSankey**: New component for energy flow diagrams
- **Solar routing**: Shows solar → battery/grid/load relationships
- **Responsive design**: Mobile-optimized Sankey
- **Keyboard navigation**: Accessibility improvements

### Composite System Enhancements

- **Historical data**: Composite systems in history API
- **Mondo charts**: Composite system visualization
- **User-based points**: Points endpoint by user
- **Grid/battery display**: Power flow indicators
- **Disabled points**: Show in extras section
- **30m intervals**: Aggregation from 5m data
- **Automatic sync**: Background data updates
- **Rest of House**: Load calculation (Case 3)

### Schema Changes

- **Migration**: Point path taxonomy fields
- **systems table**: Don't create sessions for skipped systems

### Database Tools

- **Statistics display**: Admin database info
- **Improved sync UX**: Better progress tracking

## 9–10 November 2025

### Point Reading Inspector

- **Deep inspection**: Modal for individual point readings
- **Raw/aggregated views**: Toggle between data levels
- **URL timestamps**: Shareable point inspection links
- **Daily data**: Support for daily aggregates
- **targetTime/targetDate**: Separate parameters
- **Navigation**: Move between readings

### Point Metadata System

- **Transform field**: Data transformation configuration
- **PointInfo refactoring**: Comprehensive type usage
- **Metadata throughout**: Consistent point information

### Daily Aggregation Improvements

- **Separated operations**: Delete and aggregate as distinct steps
- **Reduced duplication**: Cleaner daily aggregation code
- **Daily table usage**: History API uses daily aggregates
- **Composite daily queries**: Historical composite data
- **Performance**: Optimized aggregation pipeline
- **SOC aggregates**: avg/min/max/sample_count/error_count

### Schema Changes

- **Migration 0034/0035 (CORRUPTION INCIDENT)**:
  - **Issue**: Energy delta calculations corrupted data
  - **Impact**: Incorrect energy values in aggregates
  - **Recovery**: Documented incident, restored from backup
  - **Fix**: Corrected energy delta calculation logic

## 11–13 November 2025

### Glob Pattern Filtering

- **Series extraction**: Comprehensive overhaul
- **micromatch integration**: Glob pattern filtering
- **/api/system/[id]/series**: Series listing endpoint
- **PointManager**: Centralized series filtering
- **SQL logging**: Query debugging

### Type System Refactoring

- **Typed identifiers**: SystemId, PointId, UserId, etc.
- **Pattern matching**: Frontend glob support
- **Identifier usage**: Throughout codebase

### Chart Enhancements

- **Battery SoC**: Visualization in site charts
- **30D view fix**: Removed duplicate series (power.avg only)
- **Battery charge/discharge**: Clear display
- **Cache TTL**: Time-to-live implementation
- **CompositeTab**: Multi-select functionality

### Performance

- **Metric units**: Actual units from database
- **Renamed**: mondo-data-processor → site-data-processor
- **Dialog scrolling**: Improved popup UX

## 14–15 November 2025

### Upstash Redis KV Cache

- **Real-time cache**: Latest point values in Redis
- **Upstash integration**: Vercel KV for serverless
- **Namespace separation**: dev/prod/test environments
- **lastUpdatedMs**: Track data freshness
- **Cache utilities**: Admin endpoints for cache management
- **Subscriptions endpoint**: Read from KV cache

### Schema Changes

- **composite_point_subscriptions table**: Point-to-point subscription system
- **Migration**: Renamed `point_info.id` → `index`

### Composite Points System

- **Automatic registry**: Rebuild on metadata changes
- **Point subscriptions**: Automatic dependency tracking
- **JSON serialization**: Automatic date handling
- **Environment detection**: Centralized config

### UI Components

- **Power cards**: Composite/Mondo system support
- **SystemPowerCards**: Responsive layout component
- **Load calculation**: Improved accuracy

## 16–20 November 2025

### Amber Electric Integration (Sixth Vendor)

- **Price monitoring**: Real-time electricity pricing
- **Tariff periods**: Track pricing periods
- **24-hour gap filling**: Data quality tracking
- **Quality indicators**: Timeline visualization
- **Export rate fixes**: Sign correction bugs
- **Display timezone**: DST-aware timezone support

### Point Metadata Simplification

- **origin_sub_id**: Simplified structure
- **Metadata refactoring**: Improved naming conventions

### System Configuration

- **Default system**: User preference support
- **Alias field**: Renamed `short_name` → `alias`
- **Display timezone**: Per-system timezone configuration
- **Poll Now**: Admin menu feature

### Schema Changes

- **Migration**: Added `alias` field (renamed from short_name)
- **Migration**: Added `display_timezone` to systems
- **Migration**: Added `is_default` to system_users

### Admin Tools

- **Amber sync endpoint**: Manual sync trigger
- **Multi-day sync**: Batch synchronization
- **Row tracking**: numRowsInserted reporting
- **Error visibility**: Improved error display
- **Melbourne timezone**: Canonical display format

### Performance Optimization

- **Power card re-renders**: Optimized React rendering
- **Double lookups**: Eliminated redundant point queries
- **Instant updates**: System name/alias changes

### Database Fixes

- **Migration 0036 corruption**: Point_info data repair
- **Idempotent migrations**: Safe re-running
- **Amber data cleanup**: Delete and recreate workflow

## 17–18 November 2025

### Documentation Reorganization

- **Architecture docs**: `/docs/architecture/`
- **Vendor docs**: `/docs/vendors/`
- **Incident reports**: `/docs/incidents/`
- **ARCHITECTURE.md**: Complete rewrite with current state
- **Points documentation**: Comprehensive guide
- **Removed**: Outdated documentation

### UI Polish

- **Sankey diagram**: Vertical node ordering
- **Column alignment**: Gap-based adjustments
- **Modal spacing**: Improved layouts
- **Point Information**: Modal updates
- **LatestPointValue**: displayName field

### Load Calculations

- **Composite load**: Fixed calculation methods
- **Master load priority**: Use when available
- **Calculation docs**: Documentation of methods

## 19–22 November 2025

### Amber Sync Terminal UI

- **Refactored headers**: Improved terminal rendering
- **Session labels**: Using session ID pattern
- **Simplified structures**: Arrays to objects
- **BatchInfo**: Canonical display format
- **Timezone handling**: Fixed date calculations
- **Generic comparison**: Reusable comparison logic
- **Quality normalization**: Standardized at data entry

### Recent Features

- **Session label prefix**: Production environment markers
- **TEMP consolidation**: Point readings cleanup
- **History API fixes**: Interval calculation bugs
- **Dense timeline**: Database-level implementation
- **Cache monitoring**: Admin storage page enhancements

### Heatmap Visualization

- **/dashboard/[systemIdentifier]/heatmap**: New page
- **HeatmapChart**: Time-based pattern visualization
- **AmberCard**: Price display component

## 23–25 November 2025

### Dashboard Routing Refactor

- **Catch-all route**: Consolidated `/dashboard/[...slug]` handles all dashboard routes
- **Sub-pages**: heatmap, generator, amber, latest - accessible via `/dashboard/{id}/{subpage}`
- **URL patterns**: Support both numeric IDs and username/alias paths
- **Header refactor**: Unified navigation across all sub-pages
- **Redundant API elimination**: Sub-page components share data fetching
- **Menu visibility fixes**: Dashboard menu and layout improvements

### New Sub-Pages

- **/dashboard/{id}/generator**: Generator events and runtime tracking
- **/dashboard/{id}/latest**: Latest readings inspection with real-time data
- **/dashboard/{id}/amber**: Amber price sync (restricted to amber vendorTypes)
- **Generator events API**: `/api/system/[systemId]/generator-events`

### API Route Restructure

- **New `/api/system/[systemId]/` namespace**:
  - `generator-events/` - Generator runtime events
  - `latest/` - Latest point values
  - `point/[pointId]/` - Individual point data
  - `points/` - All points for system
  - `series/` - Available data series
- **Migrated from**: `/api/system/[systemIdentifier]/` to numeric `[systemId]`

### User Preferences

- **Default system**: Users can set a preferred default system
- **Per-user storage**: `/api/user/preferences` endpoint
- **Automatic redirect**: Dashboard redirects to default system

### Database Growth Monitoring

- **Daily snapshots**: Track database size over time via cron job
- **Hourly snapshots**: Fine-grained size tracking
- **30-day growth calculation**: Find closest historical snapshot for comparison
- **Backfill support**: Historical db snapshot restoration with indexed queries
- **Admin storage page**: Reorganized display with growth metrics
- **Table sorting**: Descending by record count

### PointManager Refactoring

- **Composite system support**: Fixed points API for composite systems
- **Centralized filtering**: PointManager handles all series extraction
- **PointPath class removed**: Replaced with utility functions

## 26 November 2025

### Amber Live Price Display

- **Real-time price**: Live electricity price shown on dashboard
- **TT Interphases font**: CRT-style retro monospace aesthetic
- **Period highlighting**: Visual indicator for current tariff period
- **Scanline effects**: CRT monitor simulation overlay
- **Dashboard refresh pattern**: Auto-refresh for live data updates
- **Amber subpage restriction**: Only show for amber vendorTypes

### Sessions Page Improvements

- **17s → <100ms**: Optimized filter-options endpoint dramatically
- **SQL DISTINCT**: Replaced fetch-all with database-level distinct queries
- **Session tri-state**: `successful` field now nullable (success/fail/unknown)
- **Pagination shortcuts**: Quick navigation for large session lists
- **Modal flash fix**: Eliminated UI flash when clicking system links
- **Denormalization removal**: Removed system_name and vendor_type from sessions table

### Legacy Code Removal

- **Removed `readings` table**: Deprecated original data storage
- **Removed `readings_agg_5m`**: Legacy aggregation (replaced by point_readings_agg_5m)
- **dataStore elimination**: Removed legacy data access layer
- **Admin API cleanup**: Removed references to deprecated tables
- **Schema cleanup**: Removed unused table definitions

## 27 November 2025

### Point Path Architecture

- **logicalPath/physicalPath split**: Clear separation of concerns
  - `physicalPath`: Vendor-specific raw path (e.g., `meter1/power`)
  - `logicalPath`: Normalized semantic path (e.g., `load.hws/power`)
  - `logicalPathStem`: Path without metric suffix (e.g., `load.hws`)
- **Schema simplification**: point_info now uses physicalPath and logicalPathStem
- **KV cache filtering**: Improved subscription filtering with logical paths
- **ViewDataModal fix**: Physical path display correction

### Path Utilities Refactor

- **stemSplit() utility**: Parse path stems for flexible matching
- **Logical path module**: `lib/path-utils/logical.ts`
- **Physical path module**: `lib/path-utils/physical.ts`
- **PointPath class removed**: Replaced with pure functions

### Bug Fixes

- **Selectronic adapter**: Report actual records count (was always 0)
- **PollAllModal**: Error tooltip and flash fixes
- **Zero records display**: Show "0" instead of dash in sessions table
- **Subscriber summary**: Fix startsWith error on undefined logicalPath

## 28 November 2025

### Sankey Diagram Polish

- **GPU-accelerated animation**: scaleX transform for smooth timeline transitions
- **Connector gap fix**: Extended connectors into boxes to fill rounded corner gaps
- **Label positioning**: Centered vertically in small nodes
- **Data value alignment**: Label box moved 2px higher when showing data values
- **"Other Loads" rename**: Changed from "Rest of House", shortened to "Other" in diagram

### UI/UX Refinements

- **"Neutral" grid state**: Show "Neutral" when grid power under 100W (instead of tiny import/export)
- **Poll Now button**: Fixed disabled state for main dashboard view
- **fault_code metricUnit**: Changed from text to number type

### Developer Experience

- **build:local script**: Separate `.next-build` directory to avoid killing dev server
- **README updates**: Expanded architecture docs, heatmap and Amber features
- **Admin/systems optimization**: Page load performance improvements

---

# Major Architectural Milestones

## Database Evolution

1. **SQLite → Turso** (17 August): Cloud migration
2. **5-minute aggregation** (17 August): Performance optimization
3. **Daily aggregation** (18 August): Long-term statistics
4. **Point readings** (4 October): Multi-point system support
5. **Composite primary keys** (3 November): Point table restructuring
6. **Upstash Redis KV** (14 November): Real-time caching layer
7. **Legacy table removal** (26 November): Removed deprecated readings tables
8. **Database growth tracking** (23 November): Hourly/daily size snapshots

## Vendor Integration Timeline

1. **Selectronic** (16 August): Initial vendor
2. **Enphase** (31 August – 5 September): OAuth, smart polling
3. **craighack** (9 September): Custom vendor
4. **Fronius** (21 September): Push-based data
5. **Mondo** (1–4 October): Multi-point systems
6. **Amber Electric** (16 November): Pricing data

## Authentication Journey

1. **Session-based** (16 August): Initial auth
2. **Clerk migration** (30 August): OAuth support
3. **Session claims** (23 September): Performance optimization

## API Architecture

1. **REST endpoints** (16 August): Initial API
2. **Cron jobs** (17 August): Scheduled tasks
3. **History refactor** (12 October): MeasurementSeries
4. **Series filtering** (11 November): Glob patterns
5. **KV subscriptions** (14 November): Real-time cache
6. **Route restructure** (23 November): `/api/system/[systemId]/` namespace

## Key UI Components

1. **Dashboard & Charts** (16 August): Initial UI
2. **Mobile menu** (23 August): Responsive design
3. **MondoPowerChart** (16 October): Multi-point visualization
4. **EnergyFlowSankey** (7 November): Energy flow diagrams
5. **Point Inspector** (9 November): Deep data inspection
6. **HeatmapChart** (22 November): Pattern visualization
7. **Generator page** (23 November): Generator runtime tracking
8. **Amber live display** (26 November): CRT-style price display
9. **Latest readings page** (26 November): Real-time point inspection
10. **Dashboard routing** (23 November): Catch-all `[...slug]` consolidation

## Critical Incidents

1. **Migration 0016** (3 November): 345K records lost, 8-hour recovery
2. **Migration 0034/0035** (10 November): Energy delta corruption
3. **Migration 0036** (16 November): Point_info corruption

---

_This document chronicles the evolution of LiveOne from a single-vendor Selectronic monitor to a comprehensive multi-vendor solar monitoring platform with advanced features including composite systems, point-level granularity, real-time caching, and sophisticated aggregation pipelines._
