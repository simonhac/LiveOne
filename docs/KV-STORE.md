# KV Store Documentation

This document describes the Redis KV store (Upstash) key organization and usage patterns.

## Overview

The application uses a shared Upstash Redis instance for both development and production environments. Proper namespace management is critical to prevent data conflicts between environments.

## Key Namespaces

### Latest Point Values

**Pattern:** `latest:system:{systemId}`

**Type:** Hash

**Description:** Stores the most recent value for each point in a system. Updated in real-time as new readings arrive.

**Structure:**

```typescript
{
  "source.solar.local/power": {
    value: 5234.5,
    measurementTimeMs: 1731627600000,
    receivedTimeMs: 1731627605000,
    metricUnit: "W"
  },
  "load.hvac/power": {
    value: 1200,
    measurementTimeMs: 1731627600000,
    receivedTimeMs: 1731627605000,
    metricUnit: "W"
  }
}
```

**Usage:**

- Written by: `updateLatestPointValue()` in `lib/kv-cache-manager.ts`
- Read by: `getLatestPointValues()` in `lib/kv-cache-manager.ts`
- API endpoint: `GET /api/system/{systemId}/points/latest`

**TTL:** None (persists indefinitely, updated on each new reading)

### Subscription Registry

**Pattern:** `subscriptions:system:{systemId}`

**Type:** JSON array

**Description:** Maps source system IDs to composite system IDs that subscribe to their point updates. When a source system's point is updated, all subscriber composite systems receive the same update.

**Structure:**

```typescript
[100, 101, 102]; // Array of composite system IDs
```

**Example:**

- Key: `subscriptions:system:6`
- Value: `[100, 101]`
- Meaning: Systems 100 and 101 are composite systems that use points from system 6

**Usage:**

- Written by: `buildSubscriptionRegistry()` in `lib/kv-cache-manager.ts`
- Read by: `getSubscribers()` in `lib/kv-cache-manager.ts` (called by `updateLatestPointValue()`)
- API endpoint: `GET /api/systems/subscriptions` (admin only)

**TTL:** None (rebuilt when composite system metadata changes)

### Username Cache

**Pattern:** `username:{username}`

**Type:** String

**Description:** Fast lookup cache for username → Clerk user ID mappings. Lazy-populated on first access to avoid slow Clerk API calls.

**Structure:**

```typescript
"user_31xcrIbiSrjjTIKlXShEPilRow7"; // Clerk user ID
```

**Example:**

- Key: `username:simon`
- Value: `"user_31xcrIbiSrjjTIKlXShEPilRow7"`

**Usage:**

- Written by: `cacheUsernameMapping()` in `lib/user-cache.ts`
- Read by: `getUserIdByUsername()` in `lib/user-cache.ts`
- Invalidated by: `invalidateUsernameCache()` / `updateUsernameCache()` in `lib/user-cache.ts`

**TTL:** None (manually invalidated when username changes)

**Performance:**

- Cache hit: ~400-500ms (network latency to Upstash Tokyo)
- Cache miss (Clerk API): ~4-10 seconds
- Speedup: ~10x faster

## Environment Separation Strategy

### Current Implementation (Namespace Prefixes)

**All environments share the same Upstash Redis instance with namespace prefixes for isolation.**

Environment variable: `KV_NAMESPACE` (values: `dev`, `prod`, `test`)

All keys are automatically prefixed by environment:

```typescript
// Development (KV_NAMESPACE=dev)
`dev:latest:system:{systemId}``dev:subscriptions:system:{systemId}``dev:username:{username}`
// Production (KV_NAMESPACE=prod)
`prod:latest:system:{systemId}``prod:subscriptions:system:{systemId}``prod:username:{username}`
// Test (KV_NAMESPACE=test)
`test:latest:system:{systemId}``test:subscriptions:system:{systemId}``test:username:{username}`;
```

**Implementation:**

All KV operations use the `kvKey()` helper function from `lib/kv.ts`:

```typescript
import { kvKey } from "@/lib/kv";

// Automatic namespace prefixing
const key = kvKey("latest:system:123");
// Returns: "dev:latest:system:123" in development
// Returns: "prod:latest:system:123" in production
```

**Environment Configuration:**

- `.env.local` (development): `KV_NAMESPACE=dev`
- Vercel production: `KV_NAMESPACE=prod` (set in dashboard)
- Integration tests: `KV_NAMESPACE=test` (set programmatically)

**Benefits:**

1. **Complete isolation** - No key collisions between environments
2. **Shared infrastructure** - Single Upstash instance for all environments
3. **Cost effective** - No need for multiple KV databases
4. **Safe testing** - Integration tests use `test:` namespace
5. **Easy cleanup** - Can delete all keys for one environment without affecting others

## Key Management Operations

### Listing All Keys by Pattern

```typescript
import { kvKey } from "@/lib/kv";

// Get all subscription keys (current environment only)
const keys = await kv.keys(kvKey("subscriptions:system:*"));

// Get all latest value keys (current environment only)
const keys = await kv.keys(kvKey("latest:system:*"));

// Get all username cache keys (current environment only)
const keys = await kv.keys(kvKey("username:*"));
```

### Deleting Keys

```typescript
import { kvKey } from "@/lib/kv";

// Single key (current environment)
await kv.del(kvKey("latest:system:123"));

// Multiple keys (current environment)
await kv.del(kvKey("latest:system:123"), kvKey("subscriptions:system:456"));
```

### Clearing Test Data

Integration tests use `test:` namespace and high system IDs (99999, 99998, etc.):

```typescript
import { kvKey } from "@/lib/kv";

// Cleanup test data (runs in test namespace)
await kv.del(
  kvKey("latest:system:99999"),
  kvKey("latest:system:99998"),
  kvKey("subscriptions:system:99999"),
);
```

### Clearing All Keys for an Environment

```bash
# WARNING: This will delete ALL keys for the environment!

# Development keys
redis-cli --pattern "dev:*" | xargs redis-cli DEL

# Test keys (safe to clear anytime)
redis-cli --pattern "test:*" | xargs redis-cli DEL
```

## Cache Invalidation Strategies

### Latest Point Values

**Strategy:** No explicit invalidation - values are overwritten on each update

**Rationale:** Point values are time-series data; the latest value is always the most relevant

### Subscription Registry

**Strategy:** Full rebuild when composite system metadata changes

**Function:** `buildSubscriptionRegistry()` in `lib/kv-cache-manager.ts`

**When to rebuild:**

- After creating a new composite system
- After updating composite system metadata (point mappings)
- After deleting a composite system

**Note:** Currently no automatic rebuild on metadata changes - requires manual trigger

### Username Cache

**Strategy:** Lazy invalidation on username change

**Functions:**

- `invalidateUsernameCache(oldUsername)` - Remove old username mapping
- `updateUsernameCache(oldUsername, newUsername, clerkId)` - Atomic update

**When to invalidate:**

- User changes their username in Clerk
- Requires webhook or manual trigger (not currently implemented)

## Performance Characteristics

### Network Latency

Upstash Redis instance is in Tokyo region:

- **Typical latency from development:** 400-900ms
- **Typical latency from production (Sydney):** ~50-100ms (estimated)

### Operation Performance

| Operation      | Type   | Latency | Notes                    |
| -------------- | ------ | ------- | ------------------------ |
| `kv.get()`     | String | ~400ms  | Single key lookup        |
| `kv.hgetall()` | Hash   | ~500ms  | Get all fields in hash   |
| `kv.hset()`    | Hash   | ~400ms  | Set single field in hash |
| `kv.keys()`    | Scan   | ~500ms  | Pattern matching scan    |
| `kv.set()`     | String | ~400ms  | Set string value         |
| `kv.del()`     | Delete | ~400ms  | Delete key               |

**Note:** These are development machine latencies (Melbourne → Tokyo). Production latencies will be lower.

## Monitoring and Debugging

### View All Subscriptions

```bash
curl http://localhost:3000/api/systems/subscriptions \
  -H "x-claude: true"
```

Returns:

```json
{
  "subscriptions": {
    "6": [100, 101],
    "5": [100],
    "7": [101]
  }
}
```

### View Latest Values for a System

```bash
curl http://localhost:3000/api/system/123/points/latest \
  -H "x-claude: true"
```

### Test Cache Performance

```bash
curl http://localhost:3000/api/test/cache
```

Returns statistics for 50 username cache lookups:

```json
{
  "count": 50,
  "first": 4936,
  "min": 385,
  "max": 4936,
  "median": 446,
  "avg": 946.4
}
```

## Migration Notes

### From No Cache → KV Cache

When migrating to KV cache for latest point values:

1. **Initial state:** KV is empty
2. **First reading:** Populates cache for each point
3. **Subsequent readings:** Update existing cached values
4. **Composites:** Subscription registry must be built first

**Build subscription registry:**

```typescript
import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";

await buildSubscriptionRegistry();
```

### Testing KV Functionality

Run integration tests (requires KV credentials in `.env.local`):

```bash
npm run test:integration kv-cache-manager
```

## Security Considerations

### Access Control

- **Admin-only endpoints:** `/api/systems/subscriptions`
- **User-scoped endpoints:** `/api/system/{systemId}/points/latest` (checks ownership)
- **Test endpoints:** `/api/test/cache` (should be removed in production)

### Data Sensitivity

- **Latest point values:** Contains real-time energy data (user-specific)
- **Subscription registry:** System metadata (admin-only)
- **Username cache:** Maps usernames to Clerk IDs (internal use)

### Credentials

- **KV_REST_API_TOKEN:** Full read/write access
- **KV_REST_API_READ_ONLY_TOKEN:** Read-only access (not currently used)

**Recommendation:** Use read-only token for monitoring/debugging operations

## Future Enhancements

### 1. Environment Namespacing

Add `prod:`, `dev:`, `test:` prefixes to all keys (see "Environment Separation Strategy" above)

### 2. TTL for Username Cache

Set expiration time for username cache entries:

```typescript
await kv.set(`username:${username}`, clerkId, { ex: 86400 }); // 24 hour TTL
```

**Benefit:** Automatic cleanup of stale entries without manual invalidation

### 3. Webhook for Username Changes

Implement Clerk webhook to invalidate cache on username changes:

```typescript
// app/api/webhooks/clerk/route.ts
if (event.type === "user.updated") {
  const oldUsername = event.data.previous.username;
  const newUsername = event.data.username;
  const clerkId = event.data.id;

  await updateUsernameCache(oldUsername, newUsername, clerkId);
}
```

### 4. Cache Warming on Startup

Pre-populate caches on application startup:

- Build subscription registry
- Warm username cache for active users

### 5. Metrics and Monitoring

Track cache performance:

- Hit/miss ratios
- Average latency
- Error rates
- Key counts by namespace

### 6. Composite System Auto-Rebuild

Automatically rebuild subscription registry when composite metadata changes:

- Listen for system updates
- Detect composite system changes
- Trigger `buildSubscriptionRegistry()`
