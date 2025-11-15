# JSON Serialization Simplification

## Overview

Simplified the API response format by using automatic JSON serialization/deserialization with date handling. This eliminates the need for separate "Formatted" types and manual date formatting throughout the codebase.

## Changes Made

### 1. Created Unified JSON Utilities ([lib/json.ts](lib/json.ts))

**Server-side: `jsonResponse()`**

- Automatically converts `measurementTimeMs` → `measurementTime` (removes "Ms" suffix)
- Converts Unix timestamps to ISO8601 strings with timezone (e.g., `"2025-11-15T05:57:03+10:00"`)
- Handles Date objects and nested structures

**Client-side: `parseJsonWithDates()`**

- Automatically deserializes ISO8601 strings back to Date objects
- Uses JSON revivor pattern

### 2. Updated API Endpoints

**[app/api/data/route.ts](app/api/data/route.ts)**

- Now uses `jsonResponse()` instead of `NextResponse.json()`
- Automatically formats all timestamps in response

**[app/api/system/[systemIdentifier]/points/latest/route.ts](app/api/system/[systemIdentifier]/points/latest/route.ts)**

- Removed manual date formatting loop
- Now uses `jsonResponse()` for automatic transformation

### 3. Simplified Types ([lib/types/api.ts](lib/types/api.ts))

**Before:**

```typescript
interface PointValueFormatted {
  measurementTime: string; // AEST formatted string
  receivedTime: string;
  // ...
}
```

**After:**

```typescript
interface LatestPointValue {
  measurementTime: Date; // Auto-deserialized Date object
  receivedTime: Date;
  // ...
}
```

No more separate "Formatted" types needed!

### 4. Updated Frontend ([components/DashboardClient.tsx](components/DashboardClient.tsx))

- Uses `parseJsonWithDates()` instead of `response.json()`
- Types now expect Date objects instead of strings
- Removed type: `LatestPointValuesFormatted` → `LatestPointValues`

## How It Works

### Backend Flow

```typescript
// KV cache stores:
{
  "measurementTimeMs": 1731627423000,  // Unix ms
  "receivedTimeMs": 1731627425000
}

// jsonResponse() transforms to:
{
  "measurementTime": "2025-11-15T05:57:03+10:00",  // ISO8601 string, field renamed
  "receivedTime": "2025-11-15T05:57:05+10:00"
}
```

### Frontend Flow

```typescript
// HTTP response contains ISO8601 strings:
{
  "measurementTime": "2025-11-15T05:57:03+10:00"
}

// parseJsonWithDates() deserializes to:
{
  measurementTime: Date  // JavaScript Date object
}
```

## Benefits

1. **Single Source of Truth**: One type (`LatestPointValue`) for both BE and FE
2. **No Manual Formatting**: Automatic date handling at API boundaries
3. **Type Safety**: Dates are Date objects, not strings
4. **Cleaner Code**: Removed 20+ lines of manual formatting
5. **Consistent**: Same pattern for all API endpoints

## API Response Example

### `/api/data?systemId=1`

```json
{
  "latest": {
    "source.solar.local/power": {
      "value": 141.23,
      "measurementTime": "2025-11-15T05:57:03+10:00",
      "receivedTime": "2025-11-15T05:57:03+10:00",
      "metricUnit": "W"
    },
    "bidi.battery/soc": {
      "value": 16.7,
      "measurementTime": "2025-11-15T05:57:00+10:00",
      "receivedTime": "2025-11-15T05:57:01+10:00",
      "metricUnit": "%"
    }
  },
  "historical": {
    /* ... */
  }
}
```

On the frontend, `measurementTime` and `receivedTime` are automatically Date objects.

## Files Changed

- ✅ [lib/json.ts](lib/json.ts) - New unified JSON utilities
- ✅ [lib/types/api.ts](lib/types/api.ts) - Simplified types (removed "Formatted" variants)
- ✅ [app/api/data/route.ts](app/api/data/route.ts) - Uses `jsonResponse()`
- ✅ [app/api/system/[systemIdentifier]/points/latest/route.ts](app/api/system/[systemIdentifier]/points/latest/route.ts) - Uses `jsonResponse()`
- ✅ [components/DashboardClient.tsx](components/DashboardClient.tsx) - Uses `parseJsonWithDates()`

## Files Removed

- ❌ `lib/json-response.ts` - Merged into `lib/json.ts`
- ❌ `lib/json-revivor.ts` - Merged into `lib/json.ts`

## Testing

The dev server should now:

1. Return ISO8601-formatted timestamps in API responses
2. Frontend automatically parses them to Date objects
3. Power cards display correctly with composite points data

Check:

- `/api/data?systemId=1` - Returns ISO8601 strings
- `/api/system/1/points/latest` - Returns ISO8601 strings
- Dashboard power cards work with Date objects
