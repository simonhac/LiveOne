# API Documentation

## Overview

LiveOne provides a RESTful API for accessing solar inverter data, managing authentication, and controlling system operations. All timestamps are in UTC unless otherwise specified.

## Authentication

Most endpoints require authentication via Clerk. Some endpoints have additional requirements:
- Admin endpoints: Require admin role
- Cron endpoints: Require Bearer token with `CRON_SECRET`
- Public endpoints: No authentication required

## Base URL

- Development: `http://localhost:3000`
- Production: Your deployed Vercel URL

## Endpoints

### 1. Public Endpoints

#### GET /api/health
Returns system health status and diagnostic information for monitoring.

**Authentication:** Not required (public endpoint for monitoring)

**Response:**
```json
{
  "status": "healthy",  // "healthy", "degraded", or "unhealthy"
  "timestamp": "2025-08-30T03:01:46.037Z",
  "checks": {
    "database": {
      "status": "pass",  // "pass" or "fail"
      "message": "Connected",
      "duration": 1  // milliseconds
    },
    "tables": {
      "status": "pass",
      "message": "All required tables exist",
      "duration": 0
    },
    "authentication": {
      "status": "pass",
      "message": "Clerk configured",
      "duration": 0
    },
    "environment": {
      "status": "pass",
      "message": "All required variables set",
      "duration": 0
    }
  },
  "details": {
    "tableCount": 7,
    "missingTables": [],  // Lists any missing required tables
    "systemCount": 2,
    "userSystemCount": 3,
    "environment": "development",
    "nodeVersion": "v24.5.0"
  }
}
```

**Status Codes:**
- `200 OK` - System is healthy
- `503 Service Unavailable` - System is degraded (some checks failing)
- `500 Internal Server Error` - System is unhealthy (critical failures)

**Use Cases:**
- Post-deployment verification
- Continuous monitoring
- Load balancer health checks
- Debugging deployment issues

---

### 2. Data Endpoints

#### GET /api/data
Returns comprehensive current and historical energy data.

**Authentication:** Required (Clerk)

**Query Parameters:**
- `systemId` (optional): Numeric ID of the system to query. If not provided, uses the first system the user has access to.

**Response:**
```json
{
  "success": true,
  "latest": {
    "timestamp": "2025-08-18T10:00:00+10:00",
    "power": {
      "solarW": 2500,
      "loadW": 1200,
      "batteryW": -1300,  // negative = charging
      "gridW": 0
    },
    "energy": {
      "today": {
        "solarKwh": 22.5,
        "loadKwh": 9.3,
        "batteryInKwh": 16.2,
        "batteryOutKwh": 4.2,
        "gridInKwh": 0,
        "gridOutKwh": 0
      },
      "total": {
        "solarKwh": 950.0,
        "loadKwh": 838.1,
        "batteryInKwh": 586.0,
        "batteryOutKwh": 581.0,
        "gridInKwh": 0,
        "gridOutKwh": 0
      }
    },
    "soc": {
      "battery": 75.5
    }
  },
  "historical": {
    "yesterday": {
      "date": "2025-08-17",
      "energy": {
        "solarKwh": 10.7,
        "loadKwh": 26.7,
        "batteryChargeKwh": 6.1,
        "batteryDischargeKwh": 24.5,
        "gridImportKwh": 0,
        "gridExportKwh": 0
      },
      "power": {
        "solar": { "minW": 9, "avgW": 451, "maxW": 2350 },
        "load": { "minW": 219, "avgW": 1114, "maxW": 3815 },
        "battery": { "minW": -2027, "avgW": 764, "maxW": 3941 },
        "grid": { "minW": 0, "avgW": 0, "maxW": 0 }
      },
      "soc": {
        "minBattery": 20.2,
        "avgBattery": 29.8,
        "maxBattery": 52.7,
        "endBattery": 24.0
      },
      "dataQuality": {
        "intervalCount": 282,
        "coverage": "98%"
      }
    }
  },
  "polling": {
    "lastPollTime": "2025-08-18T10:00:00+10:00",
    "lastSuccessTime": "2025-08-18T10:00:00+10:00",
    "lastErrorTime": null,
    "lastError": null,
    "consecutiveErrors": 0,
    "totalPolls": 1234,
    "successfulPolls": 1230,
    "isActive": true
  },
  "systemInfo": {
    "model": "SP PRO GO 7.5kW",
    "serial": "240315002",
    "ratings": "7.5kW, 48V",
    "solarSize": "9 kW",
    "batterySize": "14.3 kWh"
  }
}
```

---

#### GET /api/history
Returns historical time-series data for charting in OpenNEM format.

**Authentication:** Required (Clerk)

**Query Parameters:**
- `systemId` (required): Numeric ID of the system to query
- `interval` (required): Data interval - "5m", "30m", or "1d"
- `fields` (required): Comma-separated list of fields - "solar", "load", "battery", "grid"
- Time range (choose one option):
  - `last` (relative time): e.g., "7d", "24h", "30m" for minute intervals, or "30d" for daily intervals
  - `startTime` AND `endTime` (absolute time): 
    - For "5m" or "30m" intervals: ISO8601 datetime (e.g., "2025-08-16T10:00:00Z") or date only (e.g., "2025-08-16")
    - For "1d" interval: Date only in YYYY-MM-DD format (e.g., "2025-08-16")

**Time Range Limits:**
- "5m" interval: Maximum 7.5 days
- "30m" interval: Maximum 30 days
- "1d" interval: Maximum 13 months

**Response (OpenNEM format):**
```json
{
  "type": "energy",
  "version": "v4.1",
  "network": "liveone",
  "created_at": "2025-08-20T20:47:36+10:00",
  "data": [
    {
      "id": "liveone.1586.solar.power",
      "type": "power",
      "units": "W",
      "history": {
        "start": "2025-08-16",
        "last": "2025-08-19",
        "interval": "1d",
        "data": [723,451,948,1817]
      },
      "network": "liveone",
      "source": "selectronic",
      "description": "Total solar generation (remote + local)"
    }
    // ... more data series for requested fields
  ]
}
```

**Examples:**
```bash
# Last 30 days with daily resolution
GET /api/history?systemId=1&interval=1d&fields=solar,load&last=30d

# Specific date range with 5-minute resolution
GET /api/history?systemId=1&interval=5m&fields=battery,grid&startTime=2025-08-16T10:00:00Z&endTime=2025-08-16T15:00:00Z

# Last 7 days with 30-minute resolution
GET /api/history?systemId=1&interval=30m&fields=solar,load,battery,grid&last=7d
```

---

### 3. Authentication Endpoints

#### POST /api/auth/login
Authenticates a user (legacy endpoint, consider using Clerk sign-in).

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "your-password"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "email": "user@example.com",
    "displayName": "User",
    "role": "user"  // or "admin" for admin users
  }
}
```

---

#### POST /api/auth/logout
Logs out the current user (legacy endpoint, consider using Clerk sign-out).

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

#### GET /api/auth/check-admin
Checks if the current user has admin privileges.

**Authentication:** Required (Clerk)

**Response:**
```json
{
  "isAdmin": true,
  "userId": "user_31xcrIbiSrjjTIKlXShEPilRow7"
}
```

---

### 4. Admin Endpoints

All admin endpoints require authentication and admin role.

#### GET /api/admin/systems
Lists all configured systems with current status and data.

**Authentication:** Required (Admin only)

**Response:**
```json
{
  "success": true,
  "systems": [
    {
      "systemId": 1,
      "owner": "simon@example.com",
      "displayName": "Home Solar",
      "vendorType": "select.live",
      "vendorSiteId": "1586",
      "systemInfo": {
        "model": "SP PRO GO 7.5kW",
        "serial": "240315002",
        "ratings": "7.5kW, 48V",
        "solarSize": "9 kW",
        "batterySize": "14.3 kWh"
      },
      "polling": {
        "isActive": true,
        "isAuthenticated": true,
        "lastPollTime": "2025-08-18T10:00:00+10:00",
        "lastError": null
      },
      "data": {
        "solarPower": 2500,
        "loadPower": 1200,
        "batteryPower": -1300,
        "batterySOC": 75.5,
        "gridPower": 0,
        "timestamp": "2025-08-18T10:00:00+10:00"
      }
    }
  ],
  "totalSystems": 1,
  "activeSessions": 0,
  "timestamp": "2025-08-18T10:00:00+10:00"
}
```

---

#### GET /api/admin/storage
Returns database storage information and statistics.

**Authentication:** Required (Admin only)

**Response:**
```json
{
  "success": true,
  "database": {
    "type": "Turso",
    "url": "libsql://liveone-tokyo.turso.io",
    "environment": "production"
  },
  "storage": {
    "totalReadings": 1440000,
    "totalReadings5m": 8640,
    "totalReadings1d": 365,
    "oldestReading": "2025-01-01T00:00:00Z",
    "newestReading": "2025-08-30T12:00:00Z",
    "estimatedSizeMB": 180.5
  },
  "dataBySystem": [
    {
      "systemId": 1,
      "displayName": "Home Solar",
      "readingCount": 720000,
      "oldestReading": "2025-01-01T00:00:00Z",
      "newestReading": "2025-08-30T12:00:00Z",
      "estimatedSizeMB": 90.3
    }
  ]
}
```

---

#### POST /api/admin/test-connection
Tests connection to a Select.Live system.

**Authentication:** Required (Admin only)

**Request Body:**
```json
{
  "ownerClerkUserId": "user_31xcrIbiSrjjTIKlXShEPilRow7",
  "vendorType": "select.live",
  "vendorSiteId": "1586"
}
```

**Response:**
```json
{
  "success": true,
  "latest": {
    "timestamp": "2025-08-30T12:00:00Z",
    "power": {
      "solarW": 2500,
      "loadW": 1200,
      "batteryW": -1300,
      "gridW": 0
    },
    "soc": {
      "battery": 75.5
    },
    "energy": {
      "today": {
        "solarKwh": 22.5,
        "loadKwh": 9.3,
        "batteryInKwh": 16.2,
        "batteryOutKwh": 4.2
      }
    }
  },
  "systemInfo": {
    "model": "SP PRO GO 7.5kW",
    "serial": "240315002",
    "solarSize": "9 kW",
    "batterySize": "14.3 kWh"
  }
}
```

---

#### POST /api/admin/sync-database
Synchronizes historical data from Select.Live to the database.

**Authentication:** Required (Admin only)

**Request Body:**
```json
{
  "systemId": 1,
  "days": 7  // Number of days to sync
}
```

**Response (Server-Sent Events):**
```
data: {"progress":10,"total":100,"message":"Fetching day 1 of 7"}
data: {"progress":20,"total":100,"message":"Processing 1440 readings"}
data: {"progress":100,"total":100,"message":"Sync complete","stats":{"totalReadings":10080,"newReadings":8640,"duplicates":1440}}
```

---

#### GET /api/admin/users
Lists all users and their system access.

**Authentication:** Required (Admin only)

**Response:**
```json
{
  "success": true,
  "users": [
    {
      "clerkUserId": "user_31xcrIbiSrjjTIKlXShEPilRow7",
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

### 5. Setup Endpoints

#### POST /api/setup
Initial system setup endpoint for configuring new systems.

**Authentication:** Required (Clerk)

**Request Body:**
```json
{
  "displayName": "Home Solar",
  "vendorType": "select.live",
  "vendorSiteId": "1586",
  "timezoneOffsetMin": 600
}
```

**Response:**
```json
{
  "success": true,
  "systemId": 1,
  "message": "System configured successfully"
}
```

---

### 6. Cron Job Endpoints

These endpoints are designed to be called by scheduled jobs.

#### GET /api/cron/minutely
Polls all active systems for new data. Designed to run every minute.

**Authentication:** Required (Bearer token in production)

**Headers (production only):**
```
Authorization: Bearer ${CRON_SECRET}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "systemId": 1,
      "success": true,
      "message": "Reading saved",
      "timestamp": "2025-08-18T10:00:00Z"
    }
  ]
}
```

---

#### GET /api/cron/daily
Runs daily data aggregation. Designed to run at 00:05 daily.

**Authentication:** Required (Bearer token in production)

**Response:**
```json
{
  "success": true,
  "message": "Aggregated data for 2 systems",
  "duration": 234,
  "timestamp": "2025-08-18T00:05:00Z"
}
```

#### POST /api/cron/daily
Manually trigger aggregation with various options.

**Authentication:** Required (Admin only)

**Request Body Options:**

1. Clear and regenerate all data:
```json
{
  "action": "clear"
}
```

2. Catch up missing days:
```json
{
  "action": "catchup"
}
```

3. Aggregate specific day:
```json
{
  "systemId": "1",
  "date": "2025-08-17"
}
```

**Response:**
```json
{
  "success": true,
  "action": "clear_and_regenerate",
  "message": "Cleared and regenerated daily aggregations",
  "systems": [
    {
      "systemId": 1,
      "daysAggregated": 17
    }
  ],
  "timestamp": "2025-08-18T10:00:00Z"
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

## Rate Limiting

- No explicit rate limiting in development
- Production deployment on Vercel has platform-level rate limits
- Polling endpoints are designed for 1-minute intervals minimum
- Sync endpoint should not be called more than once per hour per system

---

## Timezone Handling

- All timestamps in database are stored as Unix timestamps (UTC)
- API responses include timezone information where relevant
- Daily aggregation respects system's configured timezone offset
- Default timezone: AEST (UTC+10)

---

## Testing

For local testing with curl:

```bash
# Public endpoint (no auth required)
curl http://localhost:3000/api/health

# Authenticated endpoint (use browser session or Clerk token)
curl http://localhost:3000/api/data \
  -H "Cookie: __session=your-clerk-session-token"

# Admin endpoint
curl http://localhost:3000/api/admin/systems \
  -H "Cookie: __session=your-clerk-session-token"

# Cron endpoint (local testing)
curl http://localhost:3000/api/cron/minutely

# Cron endpoint (production)
curl https://liveone.vercel.app/api/cron/minutely \
  -H "Authorization: Bearer ${CRON_SECRET}"
```