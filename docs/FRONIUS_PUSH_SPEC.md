# Fronius Push API Specification

## Endpoint
**URL**: `https://liveone.vercel.app/api/push/fronius`  
**Method**: `POST`  
**Content-Type**: `application/json`

## Authentication
Include these fields in every request body:
- `siteId` (string, required): Your unique Fronius site identifier
- `apiKey` (string, required): Your API key (any non-empty string for now)

## Request Body Structure

### Required Fields
```json
{
  "siteId": "your-site-id",
  "apiKey": "your-api-key", 
  "timestamp": "2025-01-21T06:00:00.000Z",
  "sequence": "unique-sequence-id"
}
```

- `timestamp` (string, required): ISO 8601 format timestamp in UTC when the reading was taken
- `sequence` (string, required): Unique sequence identifier for this reading (helps track and debug data flow)

### Optional Power Fields (Watts)
All power values should be integers representing instantaneous power in Watts. Positive values indicate flow in the expected direction, negative values indicate reverse flow.

```json
{
  "solarW": 2500,           // Total solar generation (optional if you provide local+remote)
  "solarLocalW": 1500,      // Solar measured at shunt/CT (local measurement)
  "solarRemoteW": 1000,     // Solar from string/remote inverters
  "loadW": 1800,            // Total load consumption
  "batteryW": -700,         // Battery power (positive=charging, negative=discharging)
  "gridW": 150              // Grid power (positive=import, negative=export)
}
```

### Optional Battery State
```json
{
  "batterySOC": 85.5        // Battery state of charge (0-100%)
}
```

### Optional System Status
```json
{
  "faultCode": "E102",      // Fault code as string (or null if no fault)
  "faultTimestamp": "2025-01-21T06:00:00.000Z",  // ISO8601 timestamp when fault occurred (or null)
  "generatorStatus": 1      // Generator status code (or null if no generator)
}
```

### Optional Energy Interval Fields (Wh)
Energy accumulated during this reporting interval in Watt-hours (integers):

```json
{
  "solarWhInterval": 125,         // Solar energy generated this interval
  "loadWhInterval": 90,            // Load energy consumed this interval
  "batteryInWhInterval": 35,       // Energy charged to battery this interval
  "batteryOutWhInterval": 0,       // Energy discharged from battery this interval
  "gridInWhInterval": 0,           // Energy imported from grid this interval
  "gridOutWhInterval": 10          // Energy exported to grid this interval
}
```

## Complete Example Request

```json
{
  "siteId": "fronius-site-001",
  "apiKey": "my-api-key",
  "timestamp": "2025-01-21T06:00:00.000Z",
  "sequence": "abcd/1",
  "solarW": 2500,
  "solarLocalW": 1500,
  "solarRemoteW": 1000,
  "loadW": 1800,
  "batteryW": -700,
  "gridW": 0,
  "batterySOC": 85.5,
  "faultCode": null,
  "faultTimestamp": null,
  "generatorStatus": null,
  "solarWhInterval": 125,
  "loadWhInterval": 90,
  "batteryInWhInterval": 0,
  "batteryOutWhInterval": 35,
  "gridInWhInterval": 0,
  "gridOutWhInterval": 0
}
```

## Response Formats

### Success (200 OK)
```json
{
  "success": true,
  "message": "Data received and stored",
  "systemId": 7,
  "timestamp": "2025-01-21T06:00:00.000Z",
  "delaySeconds": 2
}
```

### Error Responses

#### Missing Required Fields (400 Bad Request)
```json
{
  "error": "Missing siteId or apiKey"
}
```

#### Invalid API Key (401 Unauthorized)
```json
{
  "error": "Invalid API key"
}
```

#### System Not Found (404 Not Found)
```json
{
  "error": "System not found"
}
```

#### Duplicate Timestamp (409 Conflict)
```json
{
  "success": false,
  "error": "Duplicate timestamp - data already exists for this time",
  "timestamp": "2025-01-21T06:00:00.000Z"
}
```

#### Internal Server Error (500)
```json
{
  "success": false,
  "error": "Error message here"
}
```

## Implementation Notes

1. **Frequency**: Push data as frequently as your system generates it (typically every 1-5 minutes)

2. **Timestamp**: Always use UTC time in ISO 8601 format

3. **Null vs Zero**: 
   - Use `null` for missing/unavailable data
   - Use `0` for actual zero values
   - This distinction is important for proper data analysis

4. **Power Sign Convention**:
   - Solar: Always positive (generation)
   - Load: Always positive (consumption)
   - Battery: Positive = charging, Negative = discharging
   - Grid: Positive = import, Negative = export

5. **Solar Fields**:
   - If you have both local (shunt/CT) and remote (string inverter) measurements, provide both `solarLocalW` and `solarRemoteW`
   - If you only have total solar, just provide `solarW`
   - The system will calculate total from local+remote if both are provided

6. **Energy Intervals**:
   - Report energy accumulated since the last push
   - Use Watt-hours (Wh) as integers
   - Reset counters after each successful push

7. **Retry Logic**:
   - On network failure: Retry with exponential backoff
   - On 409 (duplicate): Skip this reading (already stored)
   - On 401: Check API key configuration
   - On 404: Check siteId configuration

8. **Testing**:
   - Test endpoint: `http://localhost:3000/api/push/fronius` (development)
   - Use GET request to check endpoint status and see required fields

## Example CURL Test

```bash
curl -X POST https://liveone.vercel.app/api/push/fronius \
  -H "Content-Type: application/json" \
  -d '{
    "siteId": "test-fronius-001",
    "apiKey": "test-key",
    "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
    "sequence": "test/'$(date +%s)'",
    "solarW": 2500,
    "loadW": 1800,
    "batteryW": -700,
    "gridW": 0,
    "batterySOC": 85.5
  }'
```

## Contact

For API keys and siteId assignment, contact the system administrator.