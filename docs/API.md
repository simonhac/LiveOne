# API Documentation

## Overview

LiveOne provides a RESTful API for accessing solar inverter data, managing authentication, and controlling system operations. All timestamps are in UTC unless otherwise specified.

## Authentication

Most endpoints require authentication via a cookie-based auth token:
- Cookie name: `auth-token`
- Cookie value: The configured `AUTH_PASSWORD` environment variable

## Base URL

- Development: `http://localhost:3000`
- Production: Your deployed Vercel URL

## Endpoints

### 1. Data Endpoints

#### GET /api/data
Returns comprehensive current and historical energy data.

**Authentication:** Not required

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

#### GET /api/data-serverless
Lightweight version of the data endpoint optimized for serverless environments.

**Authentication:** Not required

**Response:** Similar structure to `/api/data` but with simplified fields.

---

#### GET /api/history
Returns historical time-series data for charting in OpenNEM format.

**Authentication:** Required (cookie or Bearer token)

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

**Date/Time Handling:**
- For minute intervals (5m, 30m):
  - ISO8601 datetime: Parsed with timezone if specified, otherwise assumed UTC
  - Date-only string: Start time is 00:00:00, end time is 00:00:00 next day (in system timezone, no DST)
- For daily interval (1d):
  - Only accepts YYYY-MM-DD format
  - Datetime strings will be rejected

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

1. Last 30 days with daily resolution:
```bash
GET /api/history?systemId=1&interval=1d&fields=solar,load&last=30d
```

2. Specific date range with 5-minute resolution:
```bash
GET /api/history?systemId=1&interval=5m&fields=battery,grid&startTime=2025-08-16T10:00:00Z&endTime=2025-08-16T15:00:00Z
```

3. Last 7 days with 30-minute resolution:
```bash
GET /api/history?systemId=1&interval=30m&fields=solar,load,battery,grid&last=7d
```

**Error Responses:**

```json
// Missing required parameters
{
  "error": "Missing required parameter: interval. Must be one of: 5m, 30m, 1d"
}

// Invalid date format for daily interval
{
  "error": "Invalid start date format. Expected YYYY-MM-DD, got: 2025-08-16T10:00:00"
}

// Time range exceeds limit
{
  "error": "Time range exceeds maximum of 13 months for 1d interval"
}
```

---

### 2. Authentication Endpoints

#### POST /api/auth/login
Authenticates a user with email and password.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "your-password"
}
```

**Authentication:**
- Regular user: Uses `AUTH_PASSWORD` environment variable
- Admin user: Uses `ADMIN_PASSWORD` environment variable

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
Sets `auth-token` cookie on success with the provided password.

---

#### POST /api/auth/logout
Logs out the current user.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```
Clears `auth-token` cookie.

---

### 3. System Management Endpoints

#### GET /api/admin/systems
Lists all configured systems with current status and data.

**Authentication:** Required (accepts both `AUTH_PASSWORD` and `ADMIN_PASSWORD`)

**Response:**
```json
{
  "success": true,
  "systems": [
    {
      "owner": "simon",
      "displayName": "Home Solar",
      "systemNumber": "1586",
      "lastLogin": null,
      "isLoggedIn": false,
      "activeSessions": 0,
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

### 4. Cron Job Endpoints

These endpoints are designed to be called by scheduled jobs but can be triggered manually for testing.

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

**Authentication:** Required (cookie auth)

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

---

## Timezone Handling

- All timestamps in database are stored as Unix timestamps (UTC)
- API responses include timezone information where relevant
- Daily aggregation respects system's configured timezone offset
- Default timezone: AEST (UTC+10)


---

## Testing

For local testing, set the `AUTH_PASSWORD` and optionally `ADMIN_PASSWORD` environment variables:

```bash
# Login as regular user
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "your-password"}' \
  -c cookies.txt

# Login as admin user
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "admin-password"}' \
  -c cookies.txt

# Use the cookie for authenticated requests
curl http://localhost:3000/api/admin/systems \
  -b cookies.txt
```

Or pass the auth token directly:

```bash
# Regular user
curl http://localhost:3000/api/admin/systems \
  -H "Cookie: auth-token=your-password"

# Admin user
curl http://localhost:3000/api/admin/systems \
  -H "Cookie: auth-token=admin-password"
```
