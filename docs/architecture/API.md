# API Documentation

## Overview

LiveOne provides a RESTful API for accessing solar inverter data, managing systems, and monitoring energy flow. All endpoints return JSON unless otherwise specified.

**Base URLs:**

- Development: `http://localhost:3000`
- Production: `https://your-app.vercel.app`

**Authentication:** Most endpoints require Clerk authentication via centralized auth functions in `lib/api-auth.ts`. See [AUTHENTICATION.md](AUTHENTICATION.md) for details.

**Auth Functions:**

- `requireAuth` - Basic user authentication
- `requireAdmin` - Admin-only endpoints
- `requireCronOrAdmin` - Cron jobs (Bearer token) or admin
- `requireSystemAccess(request, systemId)` - System-level access checks

**Timestamps:** All timestamps are Unix epoch (seconds or milliseconds as specified) in UTC.

---

## Table of Contents

1. [Public Endpoints](#public-endpoints)
2. [Authentication](#authentication)
3. [System Management](#system-management)
4. [Data Access](#data-access)
5. [Administration](#administration)
6. [Cron Jobs](#cron-jobs)
7. [Error Responses](#error-responses)
8. [Deprecated Endpoints](#deprecated-endpoints-archive)

---

## Public Endpoints

### GET /api/health

Health check endpoint for monitoring system status.

**Authentication:** None required

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2025-08-30T03:01:46.037Z",
  "checks": {
    "database": { "status": "pass", "message": "Connected", "duration": 1 },
    "tables": { "status": "pass", "message": "All required tables exist" },
    "authentication": { "status": "pass", "message": "Clerk configured" },
    "environment": { "status": "pass", "message": "All required variables set" }
  },
  "details": {
    "tableCount": 12,
    "systemCount": 2,
    "environment": "production",
    "nodeVersion": "v24.5.0"
  }
}
```

**Status Codes:**

- `200` - System healthy
- `503` - System degraded (some checks failing)
- `500` - System unhealthy (critical failures)

---

## Authentication

### POST /api/auth/enphase/connect

Initiates Enphase OAuth 2.0 connection flow.

**Authentication:** Required (Clerk)

**Response:**

```json
{
  "authUrl": "https://api.enphaseenergy.com/oauth/authorize?...",
  "message": "Redirect user to authorization URL"
}
```

---

### GET /api/auth/enphase/callback

OAuth 2.0 callback endpoint for Enphase authorization.

**Query Parameters:**

- `code` - Authorization code from Enphase
- `state` - Security state parameter
- `error` (optional) - Error if user denied access

**Response:** Redirects to `/auth/enphase/result` with status

---

### GET /api/auth/enphase/disconnect

Checks Enphase connection status.

**Authentication:** Required (Clerk)

**Response:**

```json
{
  "connected": true,
  "systemId": "mock_system_001",
  "lastSync": "2025-08-31T12:00:00Z"
}
```

---

### GET /api/auth/check-admin

Checks if current user has admin privileges.

**Authentication:** Required (Clerk)

**Response:**

```json
{
  "isAdmin": true,
  "userId": "user_31xcrIbiSrjjTIKlXShEPilRow7"
}
```

---

## System Management

### GET /api/vendors

Returns available vendor types for system creation.

**Authentication:** Required (Clerk)

**Response:**

```json
{
  "vendors": [
    "selectronic",
    "enphase",
    "fronius",
    "mondo",
    "amber",
    "composite"
  ]
}
```

---

### POST /api/systems

Creates a new energy system (regular or composite).

**Authentication:** Required (Clerk)

**Request Body (Regular System):**

```json
{
  "vendorType": "selectronic",
  "credentials": {
    "username": "your-username",
    "password": "your-password"
  },
  "systemInfo": {
    "vendorSiteId": "1586",
    "displayName": "My Solar System",
    "model": "SP PRO GO 7.5kW",
    "serial": "240315002"
  }
}
```

**Request Body (Composite System):**

```json
{
  "vendorType": "composite",
  "displayName": "Combined System",
  "metadata": {
    "mappings": {
      "solar": ["liveone.system1.source.solar.local.power.avg"],
      "battery": ["liveone.system1.bidi.battery.power.avg"]
    }
  }
}
```

**Response:**

```json
{
  "success": true,
  "systemId": 12
}
```

---

### GET /api/systems/subscriptions

Returns subscription registry for composite systems (maps points to subscribing composite systems).

**Authentication:** Required (Clerk)

**Response:**

```json
{
  "subscriptions": {
    "1.2": ["3", "4"],
    "2.5": ["3"]
  }
}
```

---

### POST /api/test-connection

Tests connection to vendor system (used during setup wizard).

**Authentication:** Required (Clerk)

**Request Body:**

```json
{
  "vendorType": "selectronic",
  "credentials": {
    "username": "your-username",
    "password": "your-password"
  },
  "vendorSiteId": "1586"
}
```

**Response:**

```json
{
  "success": true,
  "systemInfo": {
    "model": "SP PRO GO 7.5kW",
    "serial": "240315002"
  }
}
```

---

## Data Access

### GET /api/system/[systemIdentifier]/points

Returns list of monitoring points for a system.

**Authentication:** Required (Clerk)

**Path Parameters:**

- `systemIdentifier` - System ID or alias

**Query Parameters:**

- `active` (optional) - Filter by active status (true/false)

**Response:**

```json
{
  "points": [
    {
      "systemId": 1,
      "pointId": 2,
      "displayName": "Solar Power",
      "alias": "solar_power",
      "subsystem": "solar",
      "metricType": "power",
      "metricUnit": "W",
      "active": true
    }
  ]
}
```

---

### GET /api/system/[systemIdentifier]/points/latest

Returns latest values for all points in a system.

**Authentication:** Required (Clerk)

**Path Parameters:**

- `systemIdentifier` - System ID or alias

**Response:**

```json
{
  "points": [
    {
      "systemId": 1,
      "pointId": 2,
      "value": 3500,
      "timestamp": 1693564800000,
      "displayName": "Solar Power",
      "metricUnit": "W"
    }
  ]
}
```

---

### GET /api/system/[systemIdentifier]/series

Returns time-series data for specified points in OpenNEM format.

**Authentication:** Required (Clerk)

**Path Parameters:**

- `systemIdentifier` - System ID or alias

**Query Parameters:**

- `interval` - Data interval: "5m", "30m", or "1d"
- `series` - Comma-separated list of series IDs
- Time range:
  - `last` - Relative time (e.g., "7d", "24h")
  - OR `startTime` AND `endTime` - Absolute time range

**Response (OpenNEM format):**

```json
{
  "type": "energy",
  "version": "v4.1",
  "network": "liveone",
  "data": [
    {
      "id": "liveone.1.source.solar.power.avg",
      "type": "power",
      "units": "W",
      "history": {
        "start": "2025-08-16",
        "last": "2025-08-19",
        "interval": "1d",
        "data": [723, 451, 948, 1817]
      }
    }
  ]
}
```

---

### GET /api/history

Returns historical time-series data (supports both legacy and modern systems).

**Authentication:** Required (Clerk)

**Query Parameters:**

- `systemId` - Numeric system ID (legacy parameter, prefer systemIdentifier)
- `interval` - "5m", "30m", or "1d"
- `fields` - Comma-separated: "solar", "load", "battery", "grid"
- Time range:
  - `last` - Relative time (e.g., "7d", "30d")
  - OR `startTime` AND `endTime` - Absolute time range

**Time Range Limits:**

- 5m interval: Max 7.5 days
- 30m interval: Max 30 days
- 1d interval: Max 13 months

**Response:** OpenNEM format (see /api/system/[systemIdentifier]/series)

---

### GET /api/data

Returns comprehensive current and historical energy data (legacy format for Selectronic systems).

**Authentication:** Required (Clerk)

**Query Parameters:**

- `systemId` (optional) - System ID (defaults to user's first system)

**Response:**

```json
{
  "success": true,
  "latest": {
    "timestamp": "2025-08-18T10:00:00+10:00",
    "power": {
      "solarW": 2500,
      "loadW": 1200,
      "batteryW": -1300,
      "gridW": 0
    },
    "soc": { "battery": 75.5 }
  },
  "systemInfo": {
    "model": "SP PRO GO 7.5kW",
    "serial": "240315002"
  },
  "polling": {
    "lastPollTime": "2025-08-18T10:00:00+10:00",
    "consecutiveErrors": 0
  }
}
```

---

## Administration

All admin endpoints use `requireAdmin(request)` from `lib/api-auth.ts`.

### GET /api/admin/systems

Lists all configured systems with current status.

**Response:**

```json
{
  "success": true,
  "systems": [
    {
      "systemId": 1,
      "owner": "simon@example.com",
      "displayName": "Home Solar",
      "vendorType": "selectronic",
      "polling": {
        "isActive": true,
        "lastPollTime": "2025-08-18T10:00:00+10:00"
      },
      "data": {
        "solarPower": 2500,
        "batterySOC": 75.5
      }
    }
  ],
  "totalSystems": 1
}
```

---

### GET /api/admin/systems/[systemId]/settings

Returns system settings.

**Response:**

```json
{
  "displayName": "Home Solar",
  "alias": "home",
  "model": "SP PRO GO 7.5kW",
  "timezone": "Australia/Melbourne"
}
```

---

### PATCH /api/admin/systems/[systemId]/settings

Updates system settings.

**Request Body:**

```json
{
  "displayName": "New Name",
  "alias": "new_alias"
}
```

---

### GET /api/admin/systems/[systemId]/admin-settings

Returns admin-only settings for a system.

**Response:**

```json
{
  "vendorType": "selectronic",
  "vendorSiteId": "1586",
  "status": "active",
  "timezoneOffsetMin": 600
}
```

---

### PATCH /api/admin/systems/[systemId]/admin-settings

Updates admin-only settings.

**Request Body:**

```json
{
  "status": "disabled"
}
```

---

### GET /api/admin/systems/[systemId]/composite-config

Returns composite system configuration.

**Response:**

```json
{
  "metadata": {
    "version": 1,
    "mappings": {
      "solar": ["liveone.1.source.solar.power.avg"]
    }
  }
}
```

---

### PATCH /api/admin/systems/[systemId]/composite-config

Updates composite system configuration.

**Request Body:**

```json
{
  "mappings": {
    "solar": ["liveone.1.source.solar.power.avg"]
  }
}
```

---

### POST /api/admin/systems/[systemId]/status

Updates system status (active/disabled/removed).

**Request Body:**

```json
{
  "status": "disabled"
}
```

---

### GET /api/admin/systems/[systemId]/point-readings

Returns point readings for a system with pagination.

**Query Parameters:**

- `limit` (optional) - Max records (default: 100)
- `offset` (optional) - Offset for pagination (default: 0)

**Response:**

```json
{
  "readings": [
    {
      "pointId": 2,
      "measurementTime": 1693564800000,
      "value": 3500,
      "dataQuality": "good"
    }
  ],
  "total": 1000
}
```

---

### GET /api/admin/point/[systemIdDotPointId]/readings

Returns readings for a specific point.

**Path Parameters:**

- `systemIdDotPointId` - Format: "systemId.pointId" (e.g., "1.2")

**Query Parameters:**

- `startTime` (optional) - Start timestamp (ms)
- `endTime` (optional) - End timestamp (ms)
- `limit` (optional) - Max records (default: 100)

**Response:**

```json
{
  "readings": [
    {
      "measurementTime": 1693564800000,
      "value": 3500,
      "dataQuality": "good"
    }
  ]
}
```

---

### GET /api/admin/user/[userId]/points

Returns all points accessible by a user.

**Path Parameters:**

- `userId` - Clerk user ID

**Response:**

```json
{
  "systems": [
    {
      "systemId": 1,
      "displayName": "Home Solar",
      "points": [
        {
          "pointId": 2,
          "displayName": "Solar Power",
          "metricUnit": "W"
        }
      ]
    }
  ]
}
```

---

### GET /api/admin/users

Lists all users and their system access.

**Response:**

```json
{
  "success": true,
  "users": [
    {
      "clerkUserId": "user_31xcrI...",
      "email": "simon@example.com",
      "name": "Simon",
      "role": "admin",
      "systems": [
        {
          "systemId": 1,
          "displayName": "Home Solar",
          "role": "owner"
        }
      ]
    }
  ]
}
```

---

### GET /api/admin/storage

Returns database storage information and statistics.

**Response:**

```json
{
  "success": true,
  "database": {
    "type": "Turso",
    "environment": "production"
  },
  "storage": {
    "totalReadings": 1440000,
    "totalPointReadings": 5000000,
    "estimatedSizeMB": 450
  }
}
```

---

### POST /api/admin/sync-database

Synchronizes historical data from vendor to database (Server-Sent Events).

**Request Body:**

```json
{
  "systemId": 1,
  "days": 7
}
```

**Response (SSE):**

```
data: {"progress":10,"message":"Fetching day 1 of 7"}
data: {"progress":100,"message":"Sync complete","stats":{"totalReadings":10080}}
```

---

### POST /api/admin/test-connection

Tests connection to a vendor system.

**Request Body:**

```json
{
  "ownerClerkUserId": "user_31xcrI...",
  "vendorType": "selectronic",
  "vendorSiteId": "1586"
}
```

**Response:**

```json
{
  "success": true,
  "latest": {
    "timestamp": "2025-08-30T12:00:00Z",
    "power": { "solarW": 2500 }
  },
  "systemInfo": {
    "model": "SP PRO GO 7.5kW"
  }
}
```

---

### GET /api/admin/sessions

Lists recent communication sessions.

**Query Parameters:**

- `systemId` (optional) - Filter by system
- `limit` (optional) - Max records (default: 50)

**Response:**

```json
{
  "sessions": [
    {
      "id": 123,
      "systemId": 1,
      "vendorType": "enphase",
      "cause": "POLL",
      "started": 1693564800,
      "duration": 234,
      "successful": true,
      "numRows": 288
    }
  ]
}
```

---

### GET /api/admin/sessions/[sessionId]

Returns details for a specific session.

**Path Parameters:**

- `sessionId` - Session ID

**Response:**

```json
{
  "id": 123,
  "systemId": 1,
  "started": 1693564800,
  "duration": 234,
  "successful": true,
  "response": {
    /* full API response */
  }
}
```

---

## Cron Jobs

All cron endpoints use `requireCronOrAdmin(request)` from `lib/api-auth.ts`.

### GET /api/cron/minutely

Polls all active systems for new data.

**Authentication:** Bearer token (`CRON_SECRET`) OR admin user (via `requireCronOrAdmin`)

**Headers (production):**

```
Authorization: Bearer ${CRON_SECRET}
```

**Query Parameters (development/testing only):**

- `systemId` - Poll specific system only
- `force=true` - Force polling regardless of schedule
- `date=YYYY-MM-DD` - Fetch specific date (Enphase only)

**Response:**

```json
{
  "success": true,
  "timestamp": "2025-09-04T06:51:41.838Z",
  "summary": {
    "total": 1,
    "successful": 1,
    "failed": 0,
    "skipped": 0
  },
  "results": [
    {
      "systemId": 1,
      "displayName": "Home Solar",
      "success": true,
      "timestamp": "2025-08-18T10:00:00Z",
      "data": {
        "solarW": 3500,
        "batterySOC": 85.5
      }
    }
  ]
}
```

**Polling Schedule:**

- **Selectronic**: Every minute
- **Enphase**: Every 30 min (dawn-30min to dusk+30min), hourly 01:00-05:00
- **Composite**: Never (aggregates data from other systems)

---

### GET /api/cron/daily

Runs daily data aggregation (designed for 00:05 daily).

**Authentication:** Bearer token (`CRON_SECRET`) OR admin user (via `requireCronOrAdmin`)

**Response:**

```json
{
  "success": true,
  "message": "Aggregated yesterday's data for 2 systems",
  "duration": 234,
  "results": [
    {
      "systemId": 1,
      "success": true,
      "date": "2025-08-17",
      "recordsProcessed": 288
    }
  ]
}
```

---

### POST /api/cron/daily

Manually trigger aggregation with maintenance options.

**Authentication:** Admin only

**Request Body:**

Option 1 - Regenerate all historical data:

```json
{
  "action": "regenerate"
}
```

Option 2 - Update last 7 days (default):

```json
{
  "action": "update"
}
```

**Response:**

```json
{
  "success": true,
  "action": "regenerate",
  "message": "Regenerated daily aggregations",
  "systems": [
    {
      "systemId": 1,
      "daysAggregated": 17
    }
  ]
}
```

---

## Error Responses

All endpoints return consistent error responses:

### 400 Bad Request

```json
{
  "success": false,
  "error": "Invalid request parameters"
}
```

### 401 Unauthorized

```json
{
  "error": "Unauthorized"
}
```

### 403 Forbidden

```json
{
  "error": "Admin access required"
}
```

### 404 Not Found

```json
{
  "error": "Resource not found"
}
```

### 500 Internal Server Error

```json
{
  "success": false,
  "error": "Internal server error message"
}
```

---

## Deprecated Endpoints (Archive)

The following endpoints are deprecated and may be removed in future versions:

### POST /api/auth/login

**Status:** Deprecated - Use Clerk sign-in instead
**Authentication:** None
Authenticates a user with email/password.

---

### POST /api/auth/logout

**Status:** Deprecated - Use Clerk sign-out instead
**Authentication:** Required
Logs out the current user.

---

### POST /api/setup

**Status:** Internal - Not for external use
Used by the initial setup wizard.

---

### POST /api/push/fronius

**Status:** Internal - Webhook only
Receives push data from Fronius systems.

---

### POST /api/enphase-proxy

**Status:** Internal - Proxy only
Proxies requests to Enphase API for CORS handling.

---

### GET /api/test/cache

**Status:** Development only
Tests Vercel KV cache functionality.

---

## Rate Limiting

- No explicit rate limiting in development
- Production deployment on Vercel has platform-level rate limits
- Polling endpoints designed for 1-minute intervals minimum
- Sync endpoint should not be called more than once per hour per system

---

## Timezone Handling

- All timestamps stored as Unix epoch (UTC)
- API responses include timezone information where relevant
- Daily aggregation respects system's configured timezone
- System timezone can be set via `display_timezone` field (IANA format)
