# LiveOne Architecture Documentation

## Table of Contents

1. [System Overview](#system-overview)
2. [Technology Stack](#technology-stack)
3. [Core Architecture](#core-architecture)
4. [Data Model](#data-model)
5. [Vendor Integration](#vendor-integration)
6. [Authentication & Authorization](#authentication--authorization)
7. [Data Collection Pipeline](#data-collection-pipeline)
8. [Aggregation System](#aggregation-system)
9. [Caching Strategy](#caching-strategy)
10. [API Architecture](#api-architecture)
11. [Deployment](#deployment)
12. [Monitoring & Observability](#monitoring--observability)
13. [Security](#security)
14. [Scalability](#scalability)
15. [Development Workflow](#development-workflow)

---

## System Overview

LiveOne is a **multi-vendor solar monitoring platform** that aggregates data from various solar inverter and battery systems into a unified interface. Unlike single-vendor solutions, LiveOne supports multiple vendors through a flexible adapter pattern and provides a points-based data model for customizable metrics.

### Key Capabilities

- **Multi-Vendor Support**: Selectronic, Enphase, Fronius, Amber, SolarEdge, Mondo
- **Unified Data Model**: Point-based architecture for vendor-agnostic metrics
- **Composite Systems**: Combine multiple systems (e.g., solar + battery + grid)
- **Historical Analytics**: Multi-level aggregation (raw → 5-minute → daily)
- **Real-Time Monitoring**: Latest values cached in KV store
- **Flexible Configuration**: User-customizable point definitions per system
- **Admin Tools**: System management, session tracking, diagnostics

### Architecture Principles

1. **Vendor Abstraction**: Isolate vendor-specific logic in adapters
2. **Points-First Design**: All metrics flow through configurable point definitions
3. **Serverless Native**: Fully serverless on Vercel with edge caching
4. **Data Integrity**: Multi-level validation, migration tracking, backup procedures
5. **User-Centric**: Per-user systems with role-based access control

---

## Technology Stack

### Frontend

- **Framework**: Next.js 15 (App Router, React Server Components)
- **UI Library**: shadcn/ui (Radix primitives + Tailwind CSS)
- **Charts**: Recharts for time-series visualization
- **Forms**: react-hook-form with Zod validation
- **State Management**: React hooks, URL state for filters
- **Styling**: Tailwind CSS with CSS variables for theming

### Backend

- **Runtime**: Node.js on Vercel serverless functions
- **Database**: Turso (libSQL, SQLite-compatible)
  - **Production**: `liveone-tokyo` (AWS Tokyo region)
  - **Development**: Local SQLite (`dev.db`)
- **ORM**: Drizzle ORM with type-safe query builder
- **Authentication**: Clerk (user management, JWT tokens)
- **Caching**: Upstash Redis (Tokyo region)
- **Cron Jobs**: Vercel Cron (1-minute polling intervals)

### Infrastructure

- **Hosting**: Vercel (serverless functions, edge network)
- **Database**: Turso (distributed SQLite with edge replication)
- **Cache**: Upstash Redis (Tokyo region)
- **CDN**: Vercel Edge Network
- **Region**: Primary in Tokyo (AWS ap-northeast-1)
- **Git**: GitHub with automatic deployments

### Development Tools

- **TypeScript**: Strict mode enabled
- **Testing**: Jest (unit + integration tests)
- **Linting**: ESLint with Next.js config
- **Database Tools**: Drizzle Studio, Turso CLI
- **Scripts**: Node.js utilities in `/scripts`

---

## Core Architecture

### High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         LiveOne Platform                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌───────────────┐     ┌──────────────┐     ┌──────────────┐   │
│  │   Frontend    │────▶│  API Routes  │────▶│   Database   │   │
│  │   (Next.js)   │     │ (Serverless) │     │   (Turso)    │   │
│  └───────────────┘     └──────────────┘     └──────────────┘   │
│         │                      │                     │           │
│         │                      ▼                     │           │
│         │              ┌──────────────┐             │           │
│         └─────────────▶│   Upstash    │◀────────────┘           │
│                        │    Redis     │                         │
│                        └──────────────┘                         │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Vendor Integration Layer                      │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │  Vendor Registry → Adapters → External APIs               │  │
│  │  • Selectronic  • Enphase  • Fronius  • Amber             │  │
│  │  • SolarEdge    • Mondo                                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Background Jobs (Vercel Cron)                 │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │  • Poll Systems (every minute)                            │  │
│  │  • Daily Aggregation (00:05 daily)                        │  │
│  │  • Cleanup Tasks (periodic)                               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Component Breakdown

#### 1. Frontend (Next.js App)

**Location**: `/app`, `/components`

The frontend is built with Next.js 15's App Router, using React Server Components for initial page loads and client components for interactive UI.

**Key Pages**:

- `/` - Landing page
- `/dashboard` - Main monitoring dashboard (multi-system view)
- `/system/[id]` - Single system detail view
- `/admin` - Admin tools (system management, sessions, diagnostics)
- `/setup` - New system setup wizard

**Key Components**:

- `SitePowerChart` - Main time-series chart with composite support
- `EnergyFlowSankey` - Real-time energy flow visualization
- `PointGrid` - Configurable metric display
- `CompositeTab` - Multi-system selector with presets
- `SystemSelector` - System navigation and management

#### 2. API Layer (Serverless Functions)

**Location**: `/app/api`

All API routes are serverless functions deployed on Vercel. Routes follow RESTful conventions with authentication middleware.

**API Categories**:

```
/api/auth/*              - Clerk authentication callbacks
/api/setup               - Initial system setup (Selectronic)
/api/test-connection     - Test vendor credentials
/api/cron/*              - Background job endpoints
/api/admin/*             - Admin-only endpoints
/api/data/*              - Data query endpoints
```

See [API Architecture](#api-architecture) for detailed endpoint documentation.

#### 3. Database Layer (Turso/libSQL)

**Production**: `liveone-tokyo.turso.io` (AWS Tokyo)
**Development**: Local SQLite (`dev.db`)

Turso provides a distributed SQLite database with:

- **Edge replication** for low-latency reads
- **Snapshot backups** (instant, copy-on-write)
- **SQL compatibility** with standard SQLite
- **Scalability** via horizontal read replicas

See [Data Model](#data-model) for schema details.

#### 4. Caching Layer (Upstash Redis)

**Purpose**: Store latest point values for instant dashboard loads

The Redis cache stores:

- Latest readings per system (keyed by `latest:system:{id}`)
- Subscription registry (composite system mappings)
- Username cache for fast Clerk lookups

**TTL Strategy**:

- Latest readings: None (persist indefinitely, updated on poll)
- Subscription registry: None (rebuilt when metadata changes)
- Username cache: None (manually invalidated)

#### 5. Vendor Integration Layer

**Location**: `/lib/vendors`

The vendor integration layer abstracts different solar monitoring APIs into a common interface. Each vendor has:

1. **Adapter** (`/lib/vendors/{vendor}-adapter.ts`) - Implements `VendorAdapter` interface
2. **Configuration** (`/lib/vendors/registry.ts`) - Registration and capabilities
3. **Point Definitions** (`/lib/vendors/{vendor}-points.ts`) - Metric mappings

See [Vendor Integration](#vendor-integration) for details.

#### 6. Background Jobs (Vercel Cron)

**Location**: `/app/api/cron`

Cron jobs run on Vercel's infrastructure at scheduled intervals:

- **`/api/cron/poll`** (every minute) - Poll all active systems
- **`/api/cron/daily`** (00:05 daily) - Generate daily aggregates
- **`/api/cron/cleanup`** (weekly) - Archive old data

See [Data Collection Pipeline](#data-collection-pipeline) for flow details.

---

## Data Model

LiveOne uses a **points-based data model** where all metrics (solar power, battery SoC, grid consumption, etc.) are stored as configurable "points" rather than fixed columns. This allows vendor-specific metrics without schema changes.

See `docs/SCHEMA.md` for complete table documentation and `docs/POINTS.md` for point system details.

### Core Tables

#### `systems`

Represents a single solar/battery system from a vendor.

```sql
CREATE TABLE systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_clerk_user_id TEXT NOT NULL,         -- Owner (Clerk user ID)
  vendor_type TEXT NOT NULL,                 -- 'selectronic', 'enphase', etc.
  vendor_site_id TEXT NOT NULL,              -- Vendor's system identifier
  status TEXT NOT NULL DEFAULT 'active',     -- 'active', 'paused', 'error'
  display_name TEXT NOT NULL,                -- User-visible name
  alias TEXT,                                -- Short name for URL routing
  is_default INTEGER NOT NULL DEFAULT 0,     -- Default system for user
  display_timezone TEXT NOT NULL,            -- IANA timezone for display
  timezone_offset_min INTEGER NOT NULL,      -- UTC offset in minutes
  -- ... metadata fields (model, serial, ratings, etc.)
  created_at INTEGER NOT NULL,               -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL,

  UNIQUE(owner_clerk_user_id, vendor_site_id, vendor_type),
  UNIQUE(owner_clerk_user_id, alias) WHERE alias IS NOT NULL,
  UNIQUE(owner_clerk_user_id) WHERE is_default = 1
);
```

**Key Indexes**:

- Primary key on `id`
- Unique constraint on owner + vendor_site_id + vendor_type (prevent duplicates)
- Partial unique index on `alias` (URL-friendly short names)
- Partial unique index on `is_default` (one default per user)

#### `point_info`

Defines what metrics (points) exist for each system.

```sql
CREATE TABLE point_info (
  system_id INTEGER NOT NULL,
  point_key TEXT NOT NULL,                   -- Unique identifier within system
  metric_type TEXT NOT NULL,                 -- 'power', 'energy', 'soc', etc.
  subsystem TEXT,                            -- 'solar', 'battery', 'grid', etc.
  type TEXT,                                 -- 'generation', 'consumption', etc.
  label TEXT NOT NULL,                       -- Display label
  unit TEXT NOT NULL,                        -- 'W', 'kWh', '%', etc.
  vendor_field TEXT,                         -- Vendor API field name
  transform TEXT,                            -- JSON transform config
  display_order INTEGER NOT NULL DEFAULT 0,  -- UI sort order
  visible INTEGER NOT NULL DEFAULT 1,        -- Show in UI
  is_active INTEGER NOT NULL DEFAULT 1,      -- Currently collecting data
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (system_id, point_key),
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);
```

**Point Identity**:

- Uniquely identified by `(system_id, point_key)`
- `point_key` examples: `solar_w`, `battery_soc`, `grid_import_kwh`
- Vendor-specific points allowed (e.g., `inverter_temp_c`)

**Metric Types**:

- `power` - Instantaneous power (W)
- `energy` - Cumulative energy (kWh)
- `soc` - State of charge (%)
- `voltage`, `current`, `frequency`, `temperature`, etc.

See `docs/POINTS.md` for complete point system documentation.

#### `point_readings`

Raw readings from vendor APIs.

```sql
CREATE TABLE point_readings (
  system_id INTEGER NOT NULL,
  inverter_time INTEGER NOT NULL,            -- Unix timestamp from device
  point_key TEXT NOT NULL,
  value REAL NOT NULL,                       -- Numeric value

  PRIMARY KEY (system_id, inverter_time, point_key),
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);

CREATE INDEX idx_point_readings_time ON point_readings(system_id, inverter_time DESC);
```

**Storage Model**:

- One row per point per timestamp (normalized)
- `inverter_time` is device-reported time (not server time)
- Values stored as floats for all metric types
- Typical polling: 1 reading per minute per point

**Example Data**:

```
system_id | inverter_time | point_key      | value
----------|---------------|----------------|-------
1586      | 1700000000    | solar_w        | 3450
1586      | 1700000000    | battery_soc    | 87
1586      | 1700000000    | load_w         | 1200
1586      | 1700000060    | solar_w        | 3520
1586      | 1700000060    | battery_soc    | 88
```

#### `point_readings_agg_5m`

5-minute aggregated data (pre-computed for faster queries).

```sql
CREATE TABLE point_readings_agg_5m (
  system_id INTEGER NOT NULL,
  point_key TEXT NOT NULL,
  interval_end INTEGER NOT NULL,             -- End of 5-minute bucket
  min REAL,                                  -- Minimum value in interval
  max REAL,                                  -- Maximum value in interval
  avg REAL,                                  -- Average value
  sum REAL,                                  -- Sum (for energy)
  count INTEGER NOT NULL,                    -- Number of samples

  PRIMARY KEY (system_id, point_key, interval_end),
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);

CREATE INDEX idx_agg_5m_time ON point_readings_agg_5m(system_id, interval_end DESC);
```

**Aggregation Rules**:

- `power` metrics: avg, min, max
- `energy` metrics: sum (total energy in 5min)
- `soc` metrics: avg
- Generated in real-time as data arrives

#### `point_readings_agg_daily`

Daily aggregated data (for long-term trends).

```sql
CREATE TABLE point_readings_agg_daily (
  system_id INTEGER NOT NULL,
  point_key TEXT NOT NULL,
  day_start INTEGER NOT NULL,                -- Start of day (00:00 local)
  -- Same aggregation fields as 5m
  min REAL,
  max REAL,
  avg REAL,
  sum REAL,
  count INTEGER NOT NULL,

  PRIMARY KEY (system_id, point_key, day_start),
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);
```

**Generation**:

- Created by daily cron job at 00:05
- Computed from `point_readings_agg_5m` (not raw data)
- Supports historical queries up to years

#### `composite_systems`

Defines virtual systems that combine multiple real systems.

```sql
CREATE TABLE composite_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_clerk_user_id TEXT NOT NULL,
  name TEXT NOT NULL,                        -- Display name
  slug TEXT NOT NULL,                        -- URL-friendly identifier
  description TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,    -- Pinned composite
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE(owner_clerk_user_id, slug)
);
```

#### `composite_system_members`

Maps systems to composite systems.

```sql
CREATE TABLE composite_system_members (
  composite_id INTEGER NOT NULL,
  system_id INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (composite_id, system_id),
  FOREIGN KEY (composite_id) REFERENCES composite_systems(id) ON DELETE CASCADE,
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);
```

**Composite Logic**:

- Aggregates metrics from member systems
- Sums power values (e.g., total solar from 3 systems)
- Averages percentages (e.g., overall battery SoC)
- See `docs/POINTS.md#composite-systems` for rules

#### `sessions`

Tracks API polling sessions for monitoring.

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  vendor_type TEXT NOT NULL,
  system_name TEXT NOT NULL,
  cause TEXT NOT NULL,                       -- 'CRON', 'USER', 'ADMIN'
  started INTEGER NOT NULL,                  -- Unix timestamp (ms)
  duration INTEGER,                          -- Milliseconds
  successful INTEGER NOT NULL,               -- 0 or 1
  error_code TEXT,                           -- Vendor error code
  error TEXT,                                -- Error message
  response TEXT,                             -- Full vendor response (JSON)
  num_rows INTEGER,                          -- Number of data points

  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_system_time ON sessions(system_id, started DESC);
CREATE INDEX idx_sessions_time ON sessions(started DESC);
```

**Session Causes**:

- `CRON` - Scheduled polling
- `USER` - User-triggered refresh
- `ADMIN` - Admin testing connection

#### `secure_credentials`

Encrypted vendor API credentials.

```sql
CREATE TABLE secure_credentials (
  owner_clerk_user_id TEXT NOT NULL,
  system_id INTEGER NOT NULL,
  encrypted_credentials TEXT NOT NULL,       -- AES-256-GCM encrypted JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (owner_clerk_user_id, system_id),
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);
```

**Credential Storage**:

- Encrypted with AES-256-GCM using app secret
- Never exposed via API
- Decrypted only in server-side polling code
- See [Security](#security) for encryption details

### Supporting Tables

#### `migrations`

Tracks applied database migrations.

```sql
CREATE TABLE migrations (
  id TEXT PRIMARY KEY,                       -- Migration filename
  applied_at INTEGER NOT NULL                -- Unix timestamp (ms)
);
```

**Migration Tracking**:

- Prevents duplicate migrations
- Every migration file ends with: `INSERT INTO migrations (id) VALUES (...)`
- Check status: `SELECT * FROM migrations ORDER BY applied_at DESC`

---

## Vendor Integration

LiveOne supports multiple solar monitoring vendors through a **vendor adapter pattern**. Each vendor implements a common interface while handling vendor-specific API details internally.

### Vendor Registry

**Location**: `/lib/vendors/registry.ts`

The `VendorRegistry` is a central registry of all supported vendors:

```typescript
export class VendorRegistry {
  private static adapters = new Map<VendorType, VendorAdapter>();

  static register(vendorType: VendorType, adapter: VendorAdapter) {
    this.adapters.set(vendorType, adapter);
  }

  static getAdapter(vendorType: VendorType): VendorAdapter | undefined {
    return this.adapters.get(vendorType);
  }

  static getAllAdapters(): VendorAdapter[] {
    return Array.from(this.adapters.values());
  }

  static getSupportedVendors(): VendorType[] {
    return Array.from(this.adapters.keys());
  }
}

// Registration happens at module load
VendorRegistry.register("selectronic", selectronicAdapter);
VendorRegistry.register("enphase", enphaseAdapter);
VendorRegistry.register("fronius", froniiusAdapter);
// ... etc
```

### VendorAdapter Interface

**Location**: `/lib/vendors/types.ts`

All vendor adapters must implement this interface:

```typescript
export interface VendorAdapter {
  // Metadata
  vendorType: VendorType;
  displayName: string;
  description: string;

  // Capabilities
  supportsAddSystem: boolean; // Can add systems via UI
  supportsManualSetup: boolean; // Manual credential entry
  supportsOAuth: boolean; // OAuth flow support

  // Core Operations
  testConnection(
    system: SystemWithPolling,
    credentials: VendorCredentials,
  ): Promise<TestConnectionResult>;

  fetchLatestData(
    system: SystemWithPolling,
    credentials: VendorCredentials,
  ): Promise<FetchDataResult>;

  // Point Configuration
  getDefaultPoints(system: SystemWithPolling): PointDefinition[];

  // Optional: OAuth flow
  getOAuthUrl?(userId: string, state: string): string;
  handleOAuthCallback?(code: string, state: string): Promise<OAuthResult>;
}
```

### Adapter Responsibilities

Each adapter handles:

1. **Authentication** - API keys, OAuth tokens, username/password
2. **Data Fetching** - Poll vendor API for latest readings
3. **Data Transformation** - Convert vendor format to LiveOne points
4. **Error Handling** - Map vendor errors to standard error codes
5. **Point Definitions** - Define default points for the vendor
6. **System Discovery** - Extract system metadata from API

### Example: Selectronic Adapter

**Location**: `/lib/vendors/selectronic-adapter.ts`

```typescript
export const selectronicAdapter: VendorAdapter = {
  vendorType: "selectronic",
  displayName: "Selectronic",
  description: "Selectronic SP PRO inverters via Selectronic Live",

  supportsAddSystem: true,
  supportsManualSetup: true,
  supportsOAuth: false,

  async testConnection(system, credentials) {
    // 1. Authenticate with Selectronic Live API
    const authResult = await selectronicApi.authenticate(
      credentials.systemNumber,
      credentials.password,
    );

    if (!authResult.success) {
      return {
        success: false,
        error: "Invalid credentials",
        errorCode: "AUTH_FAILED",
      };
    }

    // 2. Fetch latest data
    const data = await selectronicApi.fetchLatest(credentials.systemNumber);

    // 3. Transform to LiveOne format
    const latestData = transformSelectronicData(data);

    // 4. Extract system info
    const systemInfo = {
      model: data.inverterModel,
      serial: data.serialNumber,
      location: data.location,
      timezoneOffsetMin: data.timezoneOffset,
    };

    return {
      success: true,
      latestData,
      systemInfo,
      vendorResponse: data,
    };
  },

  async fetchLatestData(system, credentials) {
    // Similar to testConnection but for regular polling
    const data = await selectronicApi.fetchLatest(credentials.systemNumber);

    return {
      success: true,
      readings: transformSelectronicData(data),
      timestamp: data.timestamp,
    };
  },

  getDefaultPoints(system) {
    return selectronicPoints; // Imported from selectronic-points.ts
  },
};
```

### Supported Vendors

| Vendor      | Type          | Auth Method | Polling   | Status        |
| ----------- | ------------- | ----------- | --------- | ------------- |
| Selectronic | Inverter      | Password    | Push/Poll | ✅ Production |
| Enphase     | Microinverter | OAuth 2.0   | Poll      | ✅ Production |
| Fronius     | Inverter      | Push API    | Push      | 🚧 Beta       |
| Amber       | Grid          | API Key     | Poll      | ✅ Production |
| SolarEdge   | Inverter      | API Key     | Poll      | 🚧 Beta       |
| Mondo       | Inverter      | API Key     | Poll      | 🚧 Beta       |

See `/docs/vendors/` for vendor-specific documentation.

### Adding a New Vendor

1. **Create adapter file**: `/lib/vendors/{vendor}-adapter.ts`
2. **Define point mappings**: `/lib/vendors/{vendor}-points.ts`
3. **Implement interface**: All methods from `VendorAdapter`
4. **Register adapter**: Add to `VendorRegistry` in `registry.ts`
5. **Add credentials type**: Update `VendorCredentials` union type
6. **Test connection**: Use `/api/test-connection` endpoint
7. **Document**: Create `/docs/vendors/{VENDOR}.md`

---

## Authentication & Authorization

### Clerk Integration

LiveOne uses [Clerk](https://clerk.com) for authentication and user management.

**Setup**:

- **Sign Up/Sign In**: Clerk-hosted UI components
- **Session Management**: JWT tokens in cookies
- **User Metadata**: Stored in Clerk's database
- **Webhooks**: Sync user events (signup, deletion) to LiveOne

**Environment Variables**:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...
```

### Middleware Protection

**Location**: `/middleware.ts`

All routes except public pages require authentication:

```typescript
export default clerkMiddleware((auth, req) => {
  const { userId } = auth();

  // Public routes
  const publicRoutes = ["/", "/sign-in", "/sign-up"];
  if (publicRoutes.some((route) => req.nextUrl.pathname.startsWith(route))) {
    return;
  }

  // Protected routes
  if (!userId) {
    return redirectToSignIn({ returnBackUrl: req.url });
  }
});
```

### Authorization Model

**Centralized Auth**: All API authorization is handled by `/lib/api-auth.ts`. See [AUTHENTICATION.md](./AUTHENTICATION.md) for full details.

**User Roles & Access Levels**:

| Role   | Description                             |
| ------ | --------------------------------------- |
| User   | Standard user (owns systems, views own) |
| Viewer | Shared access to specific systems       |
| Admin  | Full access to all systems and data     |

**API Authorization Functions**:

| Function              | Use Case                       |
| --------------------- | ------------------------------ |
| `requireAuth`         | Any authenticated user         |
| `requireAdmin`        | Admin-only endpoints           |
| `requireCronOrAdmin`  | Cron jobs or admin access      |
| `requireSystemAccess` | System-specific with ownership |

**Access Control Pattern**:

```typescript
import { requireSystemAccess } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const authResult = await requireSystemAccess(request, systemId);
  if (authResult instanceof NextResponse) return authResult;

  const { system, canRead, canWrite, isOwner } = authResult;
  // Access granted - use context
}
```

**API Route Protection**:

- `/api/admin/*` - Uses `requireAdmin`
- `/api/data/*` - Uses `requireSystemAccess`
- `/api/setup` - Uses `requireAuth`
- `/api/cron/*` - Uses `requireCronOrAdmin`

**Cron Job Authentication**:

Cron endpoints use `requireCronOrAdmin` which accepts either:

- Bearer token: `Authorization: Bearer <CRON_SECRET>`
- Admin user session

```typescript
import { requireCronOrAdmin } from "@/lib/api-auth";

export async function POST(request: NextRequest) {
  const authResult = await requireCronOrAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  // Cron logic - authResult.isCron indicates cron vs admin
}
```

Set in Vercel: `CRON_SECRET` environment variable.

---

## Data Collection Pipeline

### Polling Architecture

LiveOne polls vendor APIs on a 1-minute interval via Vercel Cron. The polling system is designed for:

- **Resilience**: Individual failures don't stop other systems
- **Efficiency**: Parallel processing of systems
- **Monitoring**: Session tracking for debugging
- **Throttling**: Respect vendor rate limits

### Cron Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Vercel Cron (every minute)                                  │
└────────────┬────────────────────────────────────────────────┘
             │
             ▼
    ┌────────────────────┐
    │ /api/cron/poll     │
    │ (Serverless Fn)    │
    └────────┬───────────┘
             │
             ▼
    ┌─────────────────────────────┐
    │ SystemsManager.getAllActive │
    │ Returns active systems      │
    └────────┬────────────────────┘
             │
             ▼
    ┌────────────────────────────┐
    │ Process in parallel batches │
    │ (10 systems per batch)      │
    └────────┬───────────────────┘
             │
             ▼
    ┌───────────────────────────────────────┐
    │ For each system:                       │
    ├───────────────────────────────────────┤
    │ 1. Get credentials (decrypt)           │
    │ 2. Get vendor adapter                  │
    │ 3. adapter.fetchLatestData()           │
    │ 4. Transform to point readings         │
    │ 5. Store in point_readings             │
    │ 6. Update KV cache                     │
    │ 7. Trigger 5-min aggregation           │
    │ 8. Record session (success/failure)    │
    └───────────────────────────────────────┘
```

### Poll Implementation

**Location**: `/app/api/cron/poll/route.ts`

```typescript
export async function POST(request: Request) {
  // 1. Authenticate cron request
  if (
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Get all active systems
  const systemsManager = SystemsManager.getInstance();
  const systems = await systemsManager.getAllActiveSystems();

  console.log(`[Cron Poll] Starting poll of ${systems.length} systems`);

  // 3. Process systems in parallel batches (avoid overwhelming vendors)
  const BATCH_SIZE = 10;
  const results = [];

  for (let i = 0; i < systems.length; i += BATCH_SIZE) {
    const batch = systems.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((system) => pollSystem(system)),
    );
    results.push(...batchResults);
  }

  // 4. Summarize results
  const successful = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(
    `[Cron Poll] Completed: ${successful} succeeded, ${failed} failed`,
  );

  return NextResponse.json({
    success: true,
    polled: systems.length,
    successful,
    failed,
  });
}

async function pollSystem(system: SystemWithPolling) {
  const sessionStart = new Date();

  try {
    // 1. Get encrypted credentials
    const credentials = await getSystemCredentials(
      system.ownerClerkUserId,
      system.id,
    );

    if (!credentials) {
      throw new Error("No credentials found");
    }

    // 2. Get vendor adapter
    const adapter = VendorRegistry.getAdapter(system.vendorType);
    if (!adapter) {
      throw new Error(`Unknown vendor: ${system.vendorType}`);
    }

    // 3. Fetch latest data
    const result = await adapter.fetchLatestData(system, credentials);

    if (!result.success) {
      throw new Error(result.error || "Fetch failed");
    }

    // 4. Store readings
    await storeReadings(system.id, result.readings, result.timestamp);

    // 5. Update KV cache
    await updateLatestCache(system.id, result.readings);

    // 6. Trigger aggregation
    await trigger5MinAggregation(system.id, result.timestamp);

    // 7. Record successful session
    const duration = Date.now() - sessionStart.getTime();
    await sessionManager.recordSession({
      systemId: system.id,
      vendorType: system.vendorType,
      systemName: system.displayName,
      cause: "CRON",
      started: sessionStart,
      duration,
      successful: true,
      numRows: result.readings.length,
      response: result.vendorResponse,
    });

    return { success: true, systemId: system.id };
  } catch (error) {
    // Record failed session
    const duration = Date.now() - sessionStart.getTime();
    await sessionManager.recordSession({
      systemId: system.id,
      vendorType: system.vendorType,
      systemName: system.displayName,
      cause: "CRON",
      started: sessionStart,
      duration,
      successful: false,
      error: error.message,
      numRows: 0,
    });

    throw error;
  }
}
```

### Session Tracking

Every poll attempt (success or failure) creates a session record:

```typescript
await sessionManager.recordSession({
  systemId: 1586,
  vendorType: "selectronic",
  systemName: "Home System",
  cause: "CRON",
  started: new Date("2025-01-17T10:30:00Z"),
  duration: 1250, // 1.25 seconds
  successful: true,
  numRows: 12, // 12 point readings stored
  response: {
    /* vendor API response */
  },
});
```

**Session Monitoring**:

- View recent sessions in admin dashboard
- Filter by system, success/failure, time range
- Inspect vendor responses for debugging
- Identify problematic systems

---

## Aggregation System

Raw readings are aggregated at multiple levels for efficient queries:

1. **Raw** (`point_readings`) - Every reading (1-minute resolution)
2. **5-Minute** (`point_readings_agg_5m`) - Pre-computed aggregates
3. **Daily** (`point_readings_agg_daily`) - Day-level summaries

### 5-Minute Aggregation

**Trigger**: Real-time as data arrives (during polling)

**Logic**: `/lib/aggregation/aggregate-5min.ts`

```typescript
export async function aggregate5MinInterval(
  systemId: number,
  inverterTime: number,
) {
  // 1. Determine 5-minute bucket
  const intervalEnd = Math.floor(inverterTime / 300) * 300; // Round to 5min

  // 2. Get all readings in this interval
  const readings = await db
    .select()
    .from(point_readings)
    .where(
      and(
        eq(point_readings.system_id, systemId),
        gte(point_readings.inverter_time, intervalEnd - 300),
        lte(point_readings.inverter_time, intervalEnd),
      ),
    );

  // 3. Group by point_key and compute aggregates
  const aggregates = groupBy(readings, "point_key").map((group) => {
    const values = group.map((r) => r.value);

    return {
      system_id: systemId,
      point_key: group[0].point_key,
      interval_end: intervalEnd,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: average(values),
      sum: sum(values),
      count: values.length,
    };
  });

  // 4. Upsert into agg table
  await db
    .insert(point_readings_agg_5m)
    .values(aggregates)
    .onConflictDoUpdate({
      target: [
        point_readings_agg_5m.system_id,
        point_readings_agg_5m.point_key,
        point_readings_agg_5m.interval_end,
      ],
      set: {
        min: excluded(point_readings_agg_5m.min),
        max: excluded(point_readings_agg_5m.max),
        avg: excluded(point_readings_agg_5m.avg),
        sum: excluded(point_readings_agg_5m.sum),
        count: excluded(point_readings_agg_5m.count),
      },
    });
}
```

### Daily Aggregation

**Trigger**: Cron job at 00:05 daily

**Endpoint**: `/api/cron/daily`

**Logic**:

```typescript
export async function POST(request: Request) {
  // Authenticate
  if (
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { action } = await request.json();

  if (action === "catchup") {
    // Generate missing daily aggregates
    await catchupDailyAggregates();
  } else if (action === "clear") {
    // Regenerate all daily aggregates (admin only)
    await clearAndRegenerateDailyAggregates();
  }

  return NextResponse.json({ success: true });
}

async function catchupDailyAggregates() {
  // 1. Find latest day_start in agg_daily
  const latest = await db
    .select({ maxDay: max(point_readings_agg_daily.day_start) })
    .from(point_readings_agg_daily);

  const startDay = latest[0]?.maxDay ?? 0;

  // 2. Find all days in agg_5m after that
  const missingDays = await db
    .selectDistinct({
      systemId: point_readings_agg_5m.system_id,
      dayStart: sql`${point_readings_agg_5m.interval_end} - (${point_readings_agg_5m.interval_end} % 86400)`,
    })
    .from(point_readings_agg_5m)
    .where(gt(point_readings_agg_5m.interval_end, startDay));

  // 3. Generate daily aggregates for each missing day
  for (const { systemId, dayStart } of missingDays) {
    await generateDailyAggregate(systemId, dayStart);
  }
}

async function generateDailyAggregate(systemId: number, dayStart: number) {
  // Aggregate from 5-minute data
  const dayEnd = dayStart + 86400;

  const aggregates = await db
    .select({
      point_key: point_readings_agg_5m.point_key,
      min: sql`MIN(${point_readings_agg_5m.min})`,
      max: sql`MAX(${point_readings_agg_5m.max})`,
      avg: sql`AVG(${point_readings_agg_5m.avg})`,
      sum: sql`SUM(${point_readings_agg_5m.sum})`,
      count: sql`SUM(${point_readings_agg_5m.count})`,
    })
    .from(point_readings_agg_5m)
    .where(
      and(
        eq(point_readings_agg_5m.system_id, systemId),
        gte(point_readings_agg_5m.interval_end, dayStart),
        lt(point_readings_agg_5m.interval_end, dayEnd),
      ),
    )
    .groupBy(point_readings_agg_5m.point_key);

  // Insert daily aggregate
  await db
    .insert(point_readings_agg_daily)
    .values(
      aggregates.map((agg) => ({
        system_id: systemId,
        point_key: agg.point_key,
        day_start: dayStart,
        ...agg,
      })),
    )
    .onConflictDoUpdate({
      /* upsert logic */
    });
}
```

### Query Optimization

The API automatically selects the appropriate aggregation level:

```typescript
function selectAggregationLevel(timeRange: string): "raw" | "5m" | "daily" {
  const hours =
    {
      "1H": 1,
      "6H": 6,
      "24H": 24,
      "7D": 168,
      "30D": 720,
    }[timeRange] ?? 24;

  if (hours <= 6) return "raw"; // Use raw data for 1H, 6H
  if (hours <= 24) return "5m"; // Use 5-min for 24H
  return "daily"; // Use daily for 7D, 30D
}
```

**Performance Impact**:

- Raw query (24H): ~1440 rows per point = **10+ seconds**
- 5-min query (24H): ~288 rows per point = **< 1 second**
- Daily query (30D): ~30 rows per point = **< 0.5 seconds**

---

## Caching Strategy

### Upstash Redis

LiveOne uses Upstash Redis for caching latest readings and subscription mappings.

**Configuration**:

```typescript
import { kv, kvKey } from "@/lib/kv";

// Set latest reading for system (using hash for multiple points)
await kv.hset(kvKey(`latest:system:${systemId}`), {
  [pointPath]: pointValue,
});

// Get all latest readings for system
const latest = await kv.hgetall(kvKey(`latest:system:${systemId}`));
```

### Cache Keys

All keys are automatically namespaced by environment (`prod:`, `dev:`, `test:`) using the `kvKey()` helper.

| Key Pattern                 | Data                         | TTL  | Usage                    |
| --------------------------- | ---------------------------- | ---- | ------------------------ |
| `latest:system:{id}`        | Latest point readings (hash) | None | Dashboard instant load   |
| `subscriptions:system:{id}` | Point subscription registry  | None | Composite system updates |
| `username:{username}`       | Clerk user ID mapping        | None | Fast username lookups    |

### Cache Invalidation

**On Poll**:

- Update `latest:system:{id}` with new point values
- Update composite systems that subscribe to changed points

**On Metadata Update**:

- Rebuild subscription registry when composite config changes
- Automatically triggered by API endpoint

**On Username Change**:

- Invalidate old username cache entry
- Cache new username mapping

### Fallback Strategy

If Redis is unavailable:

1. Log warning
2. Query database directly
3. Continue operation (graceful degradation)

```typescript
async function getLatestReadings(systemId: number) {
  try {
    const cached = await kv.hgetall(kvKey(`latest:system:${systemId}`));
    if (cached) return cached;
  } catch (error) {
    console.warn("[Redis] Cache unavailable, falling back to DB");
  }

  // Fallback: query database
  return await db
    .select()
    .from(point_readings)
    .where(eq(point_readings.system_id, systemId))
    .orderBy(desc(point_readings.inverter_time))
    .limit(100); // Latest readings for all points
}
```

---

## API Architecture

### API Route Structure

```
/app/api/
├── auth/
│   ├── enphase/
│   │   ├── auth/route.ts          # Start OAuth flow
│   │   └── callback/route.ts      # Handle OAuth callback
│   └── clerk/                     # Clerk webhooks
├── setup/route.ts                 # Initial system setup (Selectronic)
├── test-connection/route.ts       # Test vendor credentials
├── data/
│   ├── latest/route.ts            # Get latest readings
│   ├── historical/route.ts        # Get time-series data
│   └── systems/route.ts           # List user systems
├── admin/
│   ├── systems/
│   │   ├── route.ts               # List all systems
│   │   └── [systemId]/
│   │       ├── settings/route.ts  # Update system settings
│   │       ├── delete/route.ts    # Delete system
│   │       └── points/route.ts    # Manage points
│   ├── sessions/route.ts          # View polling sessions
│   ├── sync-database/route.ts     # Sync prod to dev (dev only)
│   └── users/route.ts             # User management
├── cron/
│   ├── poll/route.ts              # Poll systems (every minute)
│   ├── daily/route.ts             # Daily aggregation (00:05)
│   └── cleanup/route.ts           # Archive old data (weekly)
└── composite/
    ├── route.ts                   # List/create composites
    └── [id]/route.ts              # Get/update/delete composite
```

### Key Endpoints

#### GET `/api/data/latest`

Get latest readings for a system or composite.

**Query Parameters**:

- `systemId` (optional) - Single system ID
- `composite` (optional) - Composite system slug or ID list
- `includeMetadata` (optional) - Include system metadata

**Response**:

```json
{
  "success": true,
  "data": {
    "solar_w": { "value": 3450, "timestamp": 1700000000, "unit": "W" },
    "battery_soc": { "value": 87, "timestamp": 1700000000, "unit": "%" },
    "load_w": { "value": 1200, "timestamp": 1700000000, "unit": "W" }
  },
  "metadata": {
    "systemId": 1586,
    "displayName": "Home System",
    "lastUpdate": 1700000000
  }
}
```

#### GET `/api/data/historical`

Get time-series data for charting.

**Query Parameters**:

- `systemIds` (required) - Comma-separated system IDs or composite slug
- `pointKeys` (required) - Comma-separated point keys
- `range` (required) - Time range: `1H`, `6H`, `24H`, `7D`, `30D`
- `aggregation` (optional) - Override auto-selection: `raw`, `5m`, `daily`

**Response**:

```json
{
  "success": true,
  "data": [
    {
      "timestamp": 1700000000,
      "solar_w": 3450,
      "battery_soc": 87,
      "load_w": 1200
    }
    // ... more data points
  ],
  "metadata": {
    "range": "24H",
    "aggregation": "5m",
    "pointCount": 288
  }
}
```

#### POST `/api/test-connection`

Test vendor credentials before adding system.

**Request Body**:

```json
{
  "vendorType": "selectronic",
  "credentials": {
    "systemNumber": "12345",
    "password": "secret"
  }
}
```

**Response**:

```json
{
  "success": true,
  "latest": {
    "solar_w": 3450,
    "battery_soc": 87
  },
  "systemInfo": {
    "model": "SP PRO",
    "serial": "ABC123",
    "location": "Melbourne, AU"
  }
}
```

#### POST `/api/admin/systems/[systemId]/settings`

Update system settings (admin only).

**Request Body**:

```json
{
  "displayName": "Updated Name",
  "alias": "home",
  "displayTimezone": "Australia/Melbourne"
}
```

**Response**:

```json
{
  "success": true,
  "message": "System updated successfully",
  "system": {
    "id": 1586,
    "displayName": "Updated Name",
    "alias": "home",
    "displayTimezone": "Australia/Melbourne"
  }
}
```

### Error Handling

All API routes use consistent error responses:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE", // Optional machine-readable code
  "details": {
    /* ... */
  } // Optional additional context
}
```

**HTTP Status Codes**:

- `200` - Success
- `400` - Bad request (validation error)
- `401` - Unauthorized (no auth token)
- `403` - Forbidden (not allowed)
- `404` - Not found
- `409` - Conflict (duplicate, constraint violation)
- `500` - Internal server error

---

## Deployment

### Vercel Platform

LiveOne is deployed on Vercel with automatic deployments from GitHub.

**Deployment Flow**:

1. Push to `main` branch
2. Vercel detects commit
3. Runs build: `npm run build`
4. Deploys to production: `liveone.vercel.app`
5. Updates edge cache

**Preview Deployments**:

- Every PR gets a unique preview URL
- Allows testing before merging to main
- Isolated environment variables

### Build Configuration

**File**: `next.config.js`

```javascript
module.exports = {
  experimental: {
    serverComponentsExternalPackages: ["@libsql/client"],
  },

  // Ignore specific warnings
  webpack: (config) => {
    config.ignoreWarnings = [{ module: /node_modules\/@libsql\/client/ }];
    return config;
  },
};
```

**File**: `.vercelignore`

```
# Exclude from deployment
dev.db*
db-backups/
docs/
*.md
!README.md
```

### Environment Variables

Set in Vercel dashboard:

**Required**:

```bash
# Database
TURSO_DATABASE_URL=libsql://liveone-tokyo-simonhac.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=<token>

# Authentication
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...

# Encryption
ENCRYPTION_KEY=<32-byte-hex-key>

# Cron
CRON_SECRET=<random-secret>

# Upstash Redis
KV_REST_API_URL=<upstash-redis-url>
KV_REST_API_TOKEN=<upstash-token>
```

**Optional**:

```bash
# Vendor-specific
ENPHASE_CLIENT_ID=<enphase-oauth-client-id>
ENPHASE_CLIENT_SECRET=<enphase-oauth-secret>
ENPHASE_REDIRECT_URI=https://liveone.vercel.app/api/auth/enphase/callback

AMBER_API_KEY=<amber-api-key>
```

### Cron Configuration

**File**: `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/cron/poll",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/daily",
      "schedule": "5 0 * * *"
    }
  ]
}
```

**Schedule Format**: Standard cron syntax

- `* * * * *` - Every minute
- `5 0 * * *` - Daily at 00:05
- `0 0 * * 0` - Weekly on Sunday at 00:00

---

## Monitoring & Observability

### Session Tracking

Every API poll is recorded in the `sessions` table:

```sql
SELECT
  datetime(started / 1000, 'unixepoch') as time,
  system_name,
  vendor_type,
  successful,
  duration,
  error
FROM sessions
ORDER BY started DESC
LIMIT 20;
```

**Metrics to Monitor**:

- **Success Rate**: `(successful polls / total polls) * 100`
- **Average Duration**: `AVG(duration)` per vendor
- **Error Frequency**: Count by error_code
- **Data Freshness**: Time since last successful poll

### Logging Strategy

**Console Logging**:

- All logs structured as JSON
- Include timestamp, level, context
- Viewable in Vercel dashboard

**Example Log**:

```typescript
console.log(
  JSON.stringify({
    level: "info",
    message: "Poll completed",
    systemId: 1586,
    vendorType: "selectronic",
    duration: 1250,
    numRows: 12,
    timestamp: new Date().toISOString(),
  }),
);
```

**Error Logging**:

```typescript
console.error(
  JSON.stringify({
    level: "error",
    message: "Poll failed",
    systemId: 1586,
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  }),
);
```

### Health Checks

Dashboard indicators:

- **System Status**: Green (< 5min old) / Yellow (5-15min) / Red (> 15min)
- **Last Poll**: Timestamp of last successful poll
- **Error Count**: Recent errors in sessions table

Admin tools:

- **Session Log**: View all recent polls with filters
- **System Diagnostics**: Test connection, view point config
- **Database Stats**: Row counts, aggregation status

---

## Security

### Credential Encryption

Vendor API credentials are encrypted using AES-256-GCM.

**Encryption Key**: 32-byte hex string in `ENCRYPTION_KEY` environment variable

**Implementation**: `/lib/secure-credentials.ts`

```typescript
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");

export function encryptCredentials(credentials: object): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  const json = JSON.stringify(credentials);
  let encrypted = cipher.update(json, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Return: iv:authTag:encrypted
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptCredentials(encrypted: string): object {
  const [ivHex, authTagHex, encryptedData] = encrypted.split(":");

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted);
}
```

**Storage**:

- Encrypted strings stored in `secure_credentials` table
- Never logged or exposed via API
- Decrypted only in server-side polling code

### Security Headers

**File**: `next.config.js`

```javascript
const securityHeaders = [
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-XSS-Protection",
    value: "1; mode=block",
  },
];
```

### SQL Injection Prevention

All database queries use parameterized statements via Drizzle ORM:

```typescript
// ✅ Safe - parameterized
await db.select().from(systems).where(eq(systems.id, systemId));

// ❌ Unsafe - string concatenation
await rawClient.execute(`SELECT * FROM systems WHERE id = ${systemId}`);
```

### Rate Limiting

Cron endpoints protected by:

1. **Secret Header**: `Authorization: Bearer ${CRON_SECRET}`
2. **Vercel Function Timeout**: 60 seconds max
3. **Vendor Rate Limits**: Handled by adapters

API endpoints:

- **Vercel Edge**: Built-in DDoS protection
- **Clerk**: Authentication rate limiting
- **Future**: Implement per-user rate limits via middleware

---

## Scalability

### Current Limits

**Vercel Pro Plan**:

- **Function Timeout**: 60 seconds (sufficient for batch polling)
- **Function Memory**: 3008 MB
- **Concurrent Executions**: 1000
- **Cron Frequency**: 1 minute minimum
- **Edge Requests**: 100M per month

**Turso Database**:

- **Storage**: Unlimited (pay per GB)
- **Reads**: Unlimited
- **Writes**: Unlimited
- **Locations**: Global edge replication

### Scaling Strategies

#### Horizontal Scaling (Systems)

Current batch processing supports thousands of systems:

```typescript
const BATCH_SIZE = 10; // Process 10 systems in parallel
const systems = await getAllActiveSystems();

for (let i = 0; i < systems.length; i += BATCH_SIZE) {
  const batch = systems.slice(i, i + BATCH_SIZE);
  await Promise.allSettled(batch.map(pollSystem));
}
```

**Capacity**:

- 10 systems per batch
- 1 second per poll (avg)
- 60 second timeout
- **Max: ~600 systems per cron run**

To scale beyond 600 systems:

1. Increase BATCH_SIZE (risk: vendor rate limits)
2. Split into multiple cron jobs (e.g., `/api/cron/poll-batch-1`, `/api/cron/poll-batch-2`)
3. Implement queueing system (e.g., Vercel Queue, AWS SQS)

#### Database Scaling

**Turso Edge Replication**:

- Read replicas in multiple regions
- Writes go to primary (Tokyo)
- Reads use nearest replica

**Aggregation Optimization**:

- Raw data retention: 90 days
- Daily aggregates: Indefinite
- Archive old raw data to object storage (future)

#### Caching Optimization

**Current**: Upstash Redis stores latest readings only

**Future Enhancements**:

- Cache aggregated queries (e.g., "24H solar generation")
- Cache composite system calculations
- Implement stale-while-revalidate pattern

---

## Development Workflow

### Local Development

```bash
# 1. Clone repository
git clone https://github.com/simonhac/liveone.git
cd liveone

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env.local
# Edit .env.local with your credentials

# 4. Initialize database
npm run db:push

# 5. Start dev server
npm run dev

# 6. Open in browser
open http://localhost:3000
```

**Development Database**:

- Uses local SQLite (`dev.db`)
- Sync from production: `npm run db:sync-prod` (dev only)
- View in Drizzle Studio: `npm run db:studio`

### Branch Strategy

- `main` - Production (auto-deploys to Vercel)
- Feature branches - `feature/description`
- Hotfixes - `hotfix/description`

### Testing

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Run all tests
npm run test:all

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

See `CLAUDE.md#Testing Guidelines` for conventions.

### Database Migrations

```bash
# 1. Create migration file
touch migrations/NNNN_description.sql

# 2. Write SQL with tracking
-- Migration: Description
ALTER TABLE ...;

INSERT INTO migrations (id) VALUES ('NNNN_description');

# 3. Apply to dev
sqlite3 dev.db < migrations/NNNN_description.sql

# 4. Test thoroughly

# 5. Create prod-safe version (if needed)
# Remove RAISE() functions for Turso compatibility

# 6. Backup production
./scripts/utils/backup-prod-db.sh

# 7. Apply to production
~/.turso/turso db shell liveone-tokyo < migrations/NNNN_description_prod.sql
```

See `CLAUDE.md#Database Migrations` for safety guidelines.

### Pre-Push Checklist

- [ ] Run `npm run build` - Catch TypeScript errors
- [ ] Run `npm test` - All tests pass
- [ ] Check dev server output - No TypeScript errors (`[1]` lines)
- [ ] Test affected features in browser
- [ ] Review changed files
- [ ] Write clear commit message

### Commit Conventions

```bash
# Feature
git commit -m "Add composite system selector to dashboard"

# Fix
git commit -m "Fix battery SoC calculation for Enphase systems"

# Refactor
git commit -m "Refactor systems table with migration 0043"

# Documentation
git commit -m "Update ARCHITECTURE.md with vendor integration details"
```

**No Claude Attribution**:

- Don't include "🤖 Generated with Claude Code"
- Don't add "Co-Authored-By: Claude"
- Keep commit messages professional and concise

---

## References

### Documentation

- **Schema**: `docs/SCHEMA.md` - Complete database schema
- **Points System**: `docs/POINTS.md` - Point-based data model
- **API Reference**: `docs/API.md` - Endpoint documentation
- **Project Guidelines**: `CLAUDE.md` - Development conventions

### Vendor Documentation

- **Selectronic**: `docs/vendors/SELECT.md`
- **Enphase**: `docs/vendors/ENPHASE_API.md`, `ENPHASE_INTEGRATION.md`
- **Fronius**: `docs/vendors/FRONIUS_PUSH_SPEC.md`

### Incident Reports

- **Migration 0016**: `docs/incidents/2025-11-17 migration 0016 point_info corruption.md`
- **Migration 0035**: `docs/incidents/2025-11-11 migration 0035 point_readings corruption.md`

### External Links

- **Vercel**: https://vercel.com/docs
- **Turso**: https://docs.turso.tech
- **Clerk**: https://clerk.com/docs
- **Drizzle ORM**: https://orm.drizzle.team
- **Next.js**: https://nextjs.org/docs

---

## Appendix

### Technology Decisions

**Why Turso over Vercel Postgres?**

- SQLite compatibility (easy local development)
- Edge replication for global performance
- Snapshot backups (instant, copy-on-write)
- No connection pooling issues

**Why Clerk over NextAuth?**

- Hosted user management
- Better DX for multi-tenant
- Built-in admin panel
- Webhook support

**Why Points over Fixed Schema?**

- Support vendor-specific metrics without migrations
- User-configurable dashboards
- Easier to add new vendors
- Flexible composite systems

**Why Drizzle over Prisma?**

- Lighter weight
- Better TypeScript inference
- Raw SQL support
- SQLite compatibility

### Glossary

- **System**: A single solar/battery installation from a vendor
- **Composite System**: Virtual system combining multiple real systems
- **Point**: A configurable metric (e.g., solar power, battery SoC)
- **Point Key**: Unique identifier for a point (e.g., `solar_w`, `battery_soc`)
- **Vendor Adapter**: Code that integrates with a vendor's API
- **Session**: A single polling attempt (success or failure)
- **Aggregation**: Pre-computed summaries (5-minute, daily)
- **KV Cache**: Redis-compatible key-value store for latest values
- **Inverter Time**: Timestamp reported by device (not server time)
- **Display Timezone**: User-selected timezone for UI display

---

**Document Version**: 1.0
**Last Updated**: 2025-01-17
**Author**: LiveOne Development Team
