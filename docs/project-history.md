# LiveOne Project History

> **Status:** record — append-only timeline.

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

## 28–30 November 2025

### API Field Renames

- **`path` → `logicalPath`**: Renamed throughout API responses (e.g. `solar.power`)
- **`name` → `pointName`**: Clearer point identifier naming
- **`physical_path` → `physicalPathTail`**: Renamed throughout codebase
- **Documentation**: POINTS.md updated to clarify logical vs physical paths

### Schema Changes

- **Migration 0060**: Rename `physical_path` → `physicalPathTail`
- **Migration 0061**: Rename `fronius` vendor → `fusher`

### Power Cards Consolidation

- **SystemPowerCards**: Single component replaces ~225 lines of inline card code in DashboardClient (sidebar + horizontal layouts)
- **Directional chevrons**: Animated chevrons on Battery/Grid cards show charge/discharge/import/export direction by flow sign
- **Typography**: `ttInterphases` font applied across power cards; narrow no-break space (U+202F) between value and unit
- **Metadata**: Card labels use `displayName` from point metadata

### fusher Rename (was fronius)

- **Vendor rename**: `fronius` → `fusher` vendor type (Fronius was the original name)
- **Backward compatibility**: `/api/push/fronius` alias routes to `/api/push/fusher` during transition
- **Credentials move**: Fronius API key moved from environment variables to Clerk credentials (with `siteId`, defaults to "kinkora")

### Tesla Integration (Seventh Vendor)

- **OAuth flow**: `/api/auth/tesla/` (connect/callback/disconnect); Fleet API with Owner API fallback
- **Adapter**: Dynamic polling intervals — 15 min default, 5 min when charging; in-memory charging-state tracking per system
- **EV points**: battery SoC, charge limit, plugged-in status, charge power, location, charge energy (`ev.battery`, `ev.charge` logical stems)
- **TeslaSmallCard**: Battery icon with charging indicator, charge percentage, and power rate
- **EV category**: Added "ev" category to composite settings

### QStash Observations Queue

- **Async mirror**: Best-effort message queue (Vercel QStash) decoupling observation ingestion from storage; enqueue errors swallowed so live ingestion never breaks
- **Observation**: A single point reading with `sessionId`, `topic`, `measurementTime`, `receivedTime`, `value`, `interval` (raw/5m/1d), and optional debug metadata
- **QueueMessage**: Unified type carrying `observations[]`, optional `session`, `systemId`, `systemName`, `batchTime`, and `env`
- **Receiver**: `/api/observations/receive`; admin endpoints split into async parallel routes (`/info`, `/messages`, `/dlq`)
- **Admin viewer**: `/admin/observations` real-time table with pause/resume queue and DLQ inspection
- **Session publishing**: Sessions published to the queue with `sessionLabel`, `cause` (CRON/ADMIN/USER), duration, and success/error state

### PlanetScale PostgreSQL Schema (Migration Groundwork)

- **DB directory reorg**: `lib/db/` split into `lib/db/turso/` (SQLite) and `lib/db/planetscale/` (PostgreSQL); imports updated to `/turso` paths
- **PG schema**: Native `boolean`, `timestamp` (UTC), and `jsonb` types instead of SQLite's integer/text encodings
- **No foreign keys**: High-throughput tables left FK-free for the queue receiver's unvalidated inserts
- **Drizzle config**: Added `drizzle-planetscale.config.ts` alongside the Turso config
- _(This is the seed of the Turso → Postgres migration — see June 2026.)_

### Vendor Adapter `fetchData` Pattern

- **Lifecycle refactor**: All adapters migrate `doPoll()` → `fetchData()`; `BaseVendorAdapter.poll()` orchestrates schedule check → session creation → fetch → insertion → completion
- **SSE in PollNowModal**: Live stage timeline streamed from `/api/cron/minutely?realTime=true`; `PollTimeline` shows per-stage durations
- **PollingStateManager**: Shared client-side SSE state manager (subscribe/unsubscribe) tracking per-system status and session-level summary
- **Session IDs**: Changed to 5-char alphanumeric prefix (`aB3xZ/1`), persisting for the lifetime of a serverless instance (~15 min)

---

# April 2026

> _December 2025 – late April 2026 was a quiet period with no committed changes on the main line._

## 27–28 April 2026

### /labs Thermal-Model Timeline (kinkora-hws)

- **HWS visualization**: 7-day midnight-to-midnight timeline at `/labs/kinkora-hws` for a hot-water system
- **Thermal model**: First-order Newton's-law model (`lib/hws-model.ts`) computes modelled hot-tap temperature from heat-pump power in `point_readings_agg_5m`; tempering-valve cap at 40°C
- **Granularity**: 5-minute slots (288/day) showing heat-pump runtime + modelled temperature gradient
- **D3 migration**: `Timeline.tsx` moved from a CSS grid of 4,032+ tooltip cells to a single SVG driven by `d3-scale`/`d3-time`/`d3-interpolate`; continuous 6h/12h/18h gridlines; one mouse-event overlay per day

### View-Only Share Tokens

- **share_tokens table**: 3-word token (e.g. `leaping-fizzy-wombat`), owner Clerk user id, optional label, optional expiry, revocation timestamp, last-used tracking
- **API**: `/api/share-tokens` CRUD (list / create with `expiresInDays` / revoke by token)
- **Management UI**: `/settings/share-tokens` page to create, copy share URLs, and revoke tokens
- **Access**: `?access=<token>` query param grants read-only access without Clerk — middleware skips `auth.protect()`, destination route validates the token against the system owner

### Schema Changes

- **Migration 0062**: Create `share_tokens` table with owner index

### Maintenance

- **Next.js bump**: 15.4.6 → 15.5.15
- **Test fix**: kv-cache-manager test updated after the db directory reorg

---

# June 2026

> **The Turso → Postgres migration.** The largest architectural effort to date: make Postgres (PlanetScale, eventually Sydney `ap-southeast-2`) the primary store for both readings and configuration, demote Turso to a disposable best-effort backup, and lay the groundwork for splitting the data-collection engine from the web frontend. The migration is **phased, flag-gated, and shadow-diff-first** — every cutover is preceded by parallel reads and a parity check, and every flag flips back instantly.

## 5 June 2026

### Observations → Postgres (Phases 1 & 2)

- **Phase 1 (#2)**: QStash queue consumer writes observations into Postgres; admin dashboard for the live pipeline
- **Phase 2 (#4)**: Historical backfill (`scripts/backfill-turso-to-postgres.ts` — streaming, sharded, resumable, idempotent; zero rows dropped); 1d aggregates published via the queue
- **Receiver fix (#3)**: QStash receiver URL uses the public domain instead of `VERCEL_URL`

## 6 June 2026

### Stage 1 — Additive Groundwork (#5)

- **Flag seam**: `lib/db/routing.ts` with all migration flags defaulting **off**
- **PG plumbing**: Connection-pool memoization; PG migrations baselined; `share_tokens` PG table created
- **Value reconciler**: Deployed for store-vs-store parity checks; read-site inventory audit completed
- **Admin consolidation (#6)**: Admin observations merged into a single page

### Session ID → UUIDv7 / Text (PR-7)

- **Text session ids in both DBs**: New sessions use time-ordered UUIDv7; historical sessions are stringified ints
- **Co-enqueue**: One combined QStash message per poll at session close — all readings in a poll share the session id
- **FK**: `point_readings.session_id → sessions.id` added as `NOT VALID` (orphan-tolerant); dropped the `sessions` unique index
- **Recovery**: ~147K response blobs restored from `sessions_archive`; deploy-window, backfill-gap, and purged Sep–Nov 2025 sessions recovered

### Compute Aggregates in Postgres — Shadow (PR-11, #7)

- **`AGG_COMPUTE_IN_PG` flag**: PG computes its own raw-vendor 5m + 1d from PG's raw `point_readings`
- **Shared math**: `lib/aggregation/point-aggregates.ts` (`aggregate5mForPoint`, `aggregate1dForPoint`) guarantees value parity between stores
- **Reads still from Turso**: Shadow-for-reads only; Turso publisher trim gated on the reconciler going GREEN
- **Timestamp fix (#8)**: Fixed observation millisecond truncation on the queue path

### Config-Read Shadow-Diff Seam (PR-8, #10)

- **`CONFIG_READS_FROM_PG` flag**: Reads PG in parallel with Turso at every config read site (SystemsManager, PointManager, `userHasSystemAccess`, share-tokens, admin routes) and logs divergence

### Schema Changes

- **Migration 0063**: Sessions text-id split

## 7 June 2026

### Phase 1 Config Authority — CUT OVER (#13, #14)

- **Flipped together**: `CONFIG_SERVE_FROM_PG` + `CONFIG_WRITES_TO_PG` in a single cutover
- **Pre-flight**: Fresh Turso snapshot + `scripts/parity-config-turso-vs-pg.ts` zero-divergence gate
- **Result**: **Postgres is now the config system-of-record**; Turso config is a stale, no-longer-written mirror
- **Rollback**: Flip flags back (instant), or PG point-in-time recovery if edits occurred post-cutover

### Enforce Clerk Auth in Middleware (PR-12, #12)

- **The bug**: `auth.protect()` was called without `await` — a no-op that threw a floating `404` and never blocked; security relied entirely on per-route handler checks
- **The fix**: Middleware callback made `async` with `await auth.protect()` — unauthenticated requests now blocked at the Edge
- **Allow-list** (`lib/route-matchers.ts`): Self-authenticating routes exempted — `/api/cron` (CRON_SECRET), `/api/push` (API key), `/api/observations` (QStash signature), `/api/auth` (vendor OAuth callbacks), `/api/health`, and Clerk's own sign-in/up pages
- **Tests (#17)**: Route-matchers extracted and the allow-list unit-tested

### Aggregation Reconciler GREEN + Durability (PR-15, #15)

- **Root cause**: The earlier "PG raw is 43–48% short" reading was a client-timezone artifact — node-postgres serializes `Date` params in local time; re-running with `TZ=UTC` showed zero deficits
- **Real blockers fixed**: Historical PG 5m never recomputed (pre-`AGG_COMPUTE_IN_PG` queue-mirror gaps), and Amber (sys 9) 5m staleness (late `updateUsage` dropped by `onConflictDoNothing`)
- **Receiver upserts 5m-native**: 5m-native systems (Amber/Enphase) heal automatically when refinements arrive late
- **Monitor cron**: New `monitor-observations` (every 15 min) watches response-presence, raw-landing vs sessions, and QStash lag/DLQ — alerts via `OBSERVATIONS_ALERT_WEBHOOK_URL`
- **Tooling**: `scripts/gap-map-raw-readings.ts` (raw-count diff) and `scripts/recompute-pg-range.ts` (idempotent recompute + 5m-native backfill)
- **Verification**: `agg_5m` and `agg_1d` reconcile with 0 mismatches across all systems; raw `point_readings` complete (`TZ=UTC`)

## 7–8 June 2026

### Engine/Web Separation — Direction of Travel (#16)

- **Goal**: Split the data-collection **engine** (cron scheduler → vendor adapters → collector → store/KV writes + QStash publish + receiver) from the **web/FE** (read-only API + Clerk auth + low-frequency config writes), as two independently deployable units
- **Cross-boundary contracts only**: Postgres, KV (engine writes / web reads), QStash observations queue, and a future Control API + job queue for web→engine commands
- **Turso is not a contract**: Engine-internal, disposable backup
- **Planned decouplings**: Split `lib/api-auth.ts` (Clerk for web vs. secret/signature for engine); extract `pollAllSystems()` / receiver / aggregation out of Next routes into host-agnostic functions; stop assuming cross-service cache coherence
- **Deployment target**: Monorepo → `packages/core` + `apps/engine` (`engine.liveone.energy`) + `apps/web` (×N)

### Documentation & Tooling

- **Docs sweeps**: Full-history parity verification, live-pipeline health, and durability-model documentation in `docs/turso-pg-migration.md`
- **`qstash-health.ts`**: Promoted to tracked `scripts/` as a reusable live mirror-health snapshot (lag / DLQ / presence)

### Current State (as of 2026-06-08)

- **Live in production**: Config authority on PG; UUIDv7 text session ids; `AGG_COMPUTE_IN_PG`; reconciler green; middleware auth enforcement
- **Verified**: Raw `point_readings` complete vs Turso (zero deficits, `TZ=UTC`); `agg_5m`/`agg_1d` parity at 0 mismatches; live QStash lag 0 / DLQ 0
- **Next**: Phase 2 — readings reads → PG (`READINGS_READS_FROM_PG`, shadow-diff first), then trim Turso publishers, then the Sydney region move, then Turso decommission

## 8–9 June 2026

### Readings Served from Postgres (Phase 2) — CUT OVER

- **Readings-read shadow (PR-12, #19)**: `READINGS_READS_FROM_PG` ON = serve Turso + a concurrent best-effort PG read + compare + log `[READINGS-SHADOW] DIVERGE`. The live read path is the raw SQL in `/api/history` (extracted to `lib/history/build-series.ts`, mirrored by `lib/history/readings-pg.ts`) plus the two admin point-readings routes. **generator-events deferred** (unbounded full-history hack — rewrite to a bounded range before migrating)
- **Pre-existing bugs fixed during burn-in (#21, #22, #23)**: admin pagination `COUNT(*)` on huge tables → index-friendly existence check (10–13s → <1s); `/api/history?interval=1d` 500 (`data_quality` absent on PG `agg_1d` → emit `NULL`); sessions join cast to use the PK index (9.5s → 0.6s); composite-system 1d day-shift on the serve path — PG 1d fetch had no `ORDER BY` (stored data was fine), fixed with `ORDER BY` + a defensive series sort
- **Serve from PG (PR-13a, #24)**: `readings-shadow.ts` → `readings-serve.ts`; `shadowServeReadings` → `serveReadings(label, pgServe, tursoServe)` — one store read on the happy path, Turso fallback only on error/`SHADOW_SKIP` (logged `[READINGS-SERVE]`). `READINGS_READS_FROM_PG` flipped **true** in prod — **Postgres now serves `/api/history` + admin point-readings**, Turso = fallback; admin readings ~10× faster. Rollback = flip false (instant)
- **Trim the raw-vendor double-write (PR-13, #26)**: With PG self-computing raw-vendor 5m/1d (`AGG_COMPUTE_IN_PG`), the Turso→queue→PG path for those aggregates was a redundant double-write — gated off behind that flag. The raw-vendor 5m publish became vendor-conditional (5m-native Amber/Enphase keep publishing), and the receiver's raw-vendor 5m / all-1d inserts became straggler-safe logging no-ops. **Raw, sessions, 5m-native, and Turso's own backup aggregates untouched.** Rollback = `AGG_COMPUTE_IN_PG=false` (restores publish + intake exactly)
- **`publishSession` cleanup**: Dropped the now-unreachable session-only publish branch in `updateSessionResult` — every poll (including 5m-native Amber/Enphase, which already route through the `PollCollector`) emits one combined session+observations message via `publishPoll`. The remaining dead publishers (`publishObservationBatch`, the gated 1d Turso→PG mirror) are deferred to Phase 4, where they serve as the `AGG_COMPUTE_IN_PG=false` rollback path
- **Config cleanup (#25)**: Removed the vestigial `USER_SECRETS` credential mechanism

### Current State (as of 2026-06-09)

- **Live in production**: Config authority on PG; **readings served from PG** (Turso = fallback); **PG is the sole raw-vendor aggregator** (`AGG_COMPUTE_IN_PG`); UUIDv7 text session ids; middleware auth enforcement
- **PR-13 burn-in GREEN**: queue lag 0 / DLQ 0 / presence 100% / raw landing < 2 min; reconciler `agg_5m --days=2` 20010/20010 and `agg_1d` (June) 261/261, **0 value-mismatches**
- **Next**: Phase 3 — Sydney region move (Vercel `syd1` + PlanetScale `ap-southeast-2` + env re-point), then Phase 4 — Turso decommission (gated on raw-durability-off-Turso)

## 10 June 2026

### Phase 3 — Region move to Sydney (CUT OVER)

- **PlanetScale → Sydney (#)**: Prod Postgres moved us-east → the 3-node HA `sydney` branch (`aws-ap-southeast-2`, PS-5 ARM, PG 17.10). Mechanism: paused the QStash queue (collection kept writing, QStash buffered) → `pg_dump -Fc`/`pg_restore` over the direct port 5432 → repointed prod `DB_*` to the Sydney pooler + redeploy → resumed → drained the backlog → recomputed the boundary day. Verified: row-parity 12/12 tables, 38/38 indexes, FK `NOT VALID` preserved; `gap-map` 0 deficits, `agg_5m`/`agg_1d` clean. us-east `main` kept hot as the burn-in rollback
- **Order-independent aggregation**: Made the PG 5m recompute order-independent (successor recompute + per-system advisory lock) so QStash parallelism > 1 is safe
- **Vercel compute → `syd1` (#31)**: Moved Vercel compute Tokyo → Sydney (`vercel.json` `regions`; confirmed by function region `syd1` on a live request) — engine now co-located with PG. Latency inverted: PG reads/writes local; the still-live inline best-effort backup write became the cross-region hop until decommission

### Phase 4a — PG raw-durability transactional outbox (#32)

- **The "PG bin before the queue"**: New `observations_outbox` table (migration `0004`) holding each poll's built `QueueMessage`. The publish seam tees the message into the outbox **in parallel with** the unchanged direct QStash enqueue; a minutely relay (`/api/cron/relay-outbox`, `drainOutbox` with `FOR UPDATE SKIP LOCKED` + per-row tx + GC) drains unpublished rows → QStash → the unchanged idempotent receiver. Closes the swallowed-enqueue and crash-at-session-close windows. Additive + reversible; the outbox carries the **message** (collection never writes the serving store — the receiver remains the single writer)
- **Monitoring**: Outbox backlog/oldest-unpublished age surfaced by `monitor-observations`, `qstash-health`, and `/admin/observations`; Slack alerts via `OBSERVATIONS_ALERT_WEBHOOK_URL`

## 11 June 2026

### Phase 3 closeout + off-site backups

- **us-east `main` decommissioned**: After a green ~26h burn-in, deleted the old us-east PG branch — `sydney` is now the standalone primary (one-off base backup taken first; all envs repointed off us-east)
- **Off-site, provider-independent PG backups (decision H)**: Stood up a daily `pg_dump -Fc` of the Sydney branch shipped by **GitHub Actions → Cloudflare R2** (`pg-backup.yml`; versioned + 14-day WORM Object-Lock, client-side `age` encryption available, GFS retention ~13 months, Slack heartbeat). A weekly **restore-drill** (`pg-restore-drill.yml`) `pg_restore`s the latest object into a throwaway `postgres:17` and asserts the row count is ≥95% of live. Complements PlanetScale PITR (which is single-blast-radius on PlanetScale infra)

### Phase 5 — Turso decommission (Postgres-only)

- **Postgres is now the sole datastore.** Removed every Turso read/write: the inline raw/5m/1d writes, config dual-writes, and the entire `lib/db/turso` module
- **Migration flags retired**: `CONFIG_*`, `READINGS_READS_FROM_PG`, `AGG_COMPUTE_IN_PG`, `WRITE_OUTBOX` (only `FLOW_MATRIX_*` remain); the dual-store seams (`config-shadow`/`readings-serve`) deleted
- **Architecture simplified**: the outbox tee is now unconditional (the durability anchor); sessions publish from an in-process pending-session registry instead of a DB read-back; daily 1d aggregation moved to a PG-only module (`lib/aggregation/daily-points.ts`); the SQLite-specific ops routes (db-stats / storage / sync-database / health) were stubbed
- **Cleanup PR**: scrubbed vestigial Turso/libsql references across code comments and docs; deleted the legacy plain-SQL `/migrations/` SQLite archive and the `db:sync-prod` dev-seed tool (`@libsql/client` dropped as a direct dependency); staged the `0006` FK-rebuild migration (unapplied)
- **Remaining manual ops**: apply the `0006` FK rebuild, the optional session-FK validation, and `turso db destroy liveone-tokyo`

### Current State (as of 2026-06-11)

- **Postgres-only**: config, readings, and all aggregation served from PostgreSQL (PlanetScale `sydney`); Vercel compute in `syd1`; raw durability anchored by the PG transactional outbox + relay; off-site DR to R2. Turso is gone

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
9. **QStash observations queue** (29 November): Async best-effort mirror pipeline
10. **PlanetScale Postgres schema** (29 November): Second store introduced; db dirs split turso/planetscale
11. **Postgres-primary config cutover** (7 June 2026): PG becomes the config system-of-record; Turso → disposable backup
12. **Postgres-primary readings cutover** (9 June 2026): PG serves all readings and is the sole raw-vendor aggregator; Turso → fallback only (raw + sessions best-effort backup)
13. **Sydney region move + HA** (10 June 2026): PlanetScale → 3-node HA `sydney` branch (`ap-southeast-2`), Vercel compute → `syd1`; PG transactional outbox + relay for raw durability
14. **Turso decommission — Postgres-only** (11 June 2026): every Turso read/write removed, `lib/db/turso` deleted, migration flags retired; PostgreSQL (PlanetScale Sydney) is the sole datastore, with off-site DR to Cloudflare R2

## Vendor Integration Timeline

1. **Selectronic** (16 August): Initial vendor
2. **Enphase** (31 August – 5 September): OAuth, smart polling
3. **craighack** (9 September): Custom vendor
4. **Fronius** (21 September): Push-based data
5. **Mondo** (1–4 October): Multi-point systems
6. **Amber Electric** (16 November): Pricing data
7. **Tesla** (29 November): EV/battery via Fleet API OAuth, charge-aware polling
   - **fronius → fusher** (29 November): Push vendor renamed (with compat alias)

## Authentication Journey

1. **Session-based** (16 August): Initial auth
2. **Clerk migration** (30 August): OAuth support
3. **Session claims** (23 September): Performance optimization
4. **View-only share tokens** (28 April 2026): `?access=<token>` read-only links, no Clerk required
5. **Middleware enforcement** (7 June 2026): Real `await auth.protect()` at the Edge + self-auth route allow-list

## API Architecture

1. **REST endpoints** (16 August): Initial API
2. **Cron jobs** (17 August): Scheduled tasks
3. **History refactor** (12 October): MeasurementSeries
4. **Series filtering** (11 November): Glob patterns
5. **KV subscriptions** (14 November): Real-time cache
6. **Route restructure** (23 November): `/api/system/[systemId]/` namespace
7. **QStash observations queue** (29 November): Async receiver + admin endpoints
8. **Postgres store migration** (June 2026): Flag-gated, shadow-diff cutover off Turso

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
11. **SystemPowerCards & TeslaSmallCard** (29 November): Consolidated power cards with directional chevrons
12. **Observations admin viewer** (29 November): Live queue/DLQ inspection
13. **kinkora-hws thermal timeline** (28 April 2026): D3 SVG hot-water thermal model

## Critical Incidents

1. **Migration 0016** (3 November): 345K records lost, 8-hour recovery — A composite-primary-key migration dropped tables without validating the copy, losing 345,456 `point_readings`; all rows were fully restored from backup over an 8+ hour recovery with no permanent data loss.
2. **Migration 0034/0035** (10 November): Energy delta corruption — Faulty energy-delta calculations corrupted aggregate energy values; the affected aggregates were restored from backup with no permanent data loss.
3. **Migration 0036** (16 November): Point_info corruption — A migration corrupted `point_info` records; the data was fully repaired in place via a follow-up data-repair migration with no permanent data loss.

---

_This document chronicles the evolution of LiveOne from a single-vendor Selectronic monitor to a comprehensive multi-vendor solar monitoring platform with advanced features including composite systems, point-level granularity, real-time caching, and sophisticated aggregation pipelines. Its most recent chapter — the staged Turso → Postgres migration — is now complete: the platform runs Postgres-only (PlanetScale, Sydney), co-located with Vercel compute in `syd1`, with raw durability anchored by a transactional outbox and off-site DR to Cloudflare R2. The next chapter is the engine/web separation this migration enables: an independently deployable data-collection engine._
