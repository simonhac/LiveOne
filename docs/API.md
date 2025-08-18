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
Returns historical time-series data for charting.

**Authentication:** Not required

**Query Parameters:**
- `range` (optional): Time range - "24H" (default), "7D", "30D", "1Y"
- `resolution` (optional): Data resolution - "5m", "1h", "1d"

**Response:**
```json
{
  "success": true,
  "range": "24H",
  "data": [
    {
      "timestamp": "2025-08-18T00:00:00Z",
      "solarW": 0,
      "loadW": 450,
      "batteryW": 450,
      "gridW": 0,
      "batterySOC": 75.5
    }
    // ... more data points
  ]
}
```

---

### 2. Authentication Endpoints

#### POST /api/auth/login
Authenticates a user with password.

**Request Body:**
```json
{
  "password": "your-password"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful"
}
```
Sets `auth-token` cookie on success.

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
Lists all configured systems.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "systems": [
    {
      "id": 1,
      "userId": "simon",
      "systemNumber": "1586",
      "displayName": "Home Solar",
      "model": "SP PRO GO 7.5kW",
      "serial": "240315002",
      "ratings": "7.5kW, 48V",
      "solarSize": "9 kW",
      "batterySize": "14.3 kWh",
      "timezoneOffset": 10,
      "createdAt": "2025-08-01T00:00:00Z",
      "updatedAt": "2025-08-18T00:00:00Z"
    }
  ]
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

## WebSocket/SSE Support

Server-Sent Events (SSE) endpoints have been deprecated in favor of polling due to Vercel serverless limitations. Use polling with 30-second intervals for near real-time updates.

---

## Testing

For local testing, set the `AUTH_PASSWORD` environment variable and use cookie authentication:

```bash
# Login first
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password": "your-password"}' \
  -c cookies.txt

# Use the cookie for authenticated requests
curl http://localhost:3000/api/admin/systems \
  -b cookies.txt
```

Or pass the auth token directly:

```bash
curl http://localhost:3000/api/admin/systems \
  -H "Cookie: auth-token=your-password"
```

---

## Migration Notes

### Deprecated/Removed Endpoints
- `/api/sse/*` - Removed, replaced with polling via `/api/data`
- `/api/cron/aggregate-daily` - Renamed to `/api/cron/daily`
- `/api/cron/poll-systems` - Renamed to `/api/cron/minutely`
- `/api/cron/cleanup` - Removed (no automatic retention implemented)
- `/api/polling/start` - Removed (use `/api/cron/minutely` instead)
- `/api/status` - Removed (use `/api/data` instead)

### Breaking Changes
- SSE support removed in favor of polling
- Battery metrics renamed: `batteryInKwh`/`batteryOutKwh` (today) vs `batteryChargeKwh`/`batteryDischargeKwh` (historical)