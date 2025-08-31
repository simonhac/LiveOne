# Enphase Integration Testing Guide

## Overview

This guide explains how to test the Enphase integration without having access to a real Enphase system. The implementation includes a comprehensive mock client that simulates Enphase API responses.

## Testing Setup

### 1. Enable Mock Mode

Set the following environment variable in your `.env.local`:

```bash
ENPHASE_USE_MOCK=true
```

Or rely on development mode auto-detection (mock is used when `NODE_ENV=development` and no real API key is set).

### 2. Mock Credentials (Optional)

If you want to test with the real OAuth flow but mock data, add these to `.env.local`:

```bash
ENPHASE_API_KEY=mock_api_key_for_testing
ENPHASE_CLIENT_ID=mock_client_id
ENPHASE_CLIENT_SECRET=mock_client_secret
ENPHASE_REDIRECT_URI=http://localhost:3000/api/auth/enphase/callback
```

## Testing Workflows

### 1. Testing System Registration (OAuth Flow)

1. **Start the development server:**
   ```bash
   npm run dev
   ```

2. **Open the dashboard:**
   - Navigate to http://localhost:3000/dashboard
   - Click the Settings icon (cog) in the header

3. **Connect Enphase System:**
   - Click "Connect Enphase System"
   - In mock mode, you'll be redirected to a mock auth page
   - The mock will automatically approve and redirect back
   - A mock system "Mock Solar System" will be created

4. **Verify Connection:**
   - The Settings modal should show "Status: Connected"
   - Check the database for the new system:
   ```sql
   SELECT * FROM systems WHERE vendor_type = 'enphase';
   ```

### 2. Testing Data Collection

1. **Trigger Manual Poll:**
   ```bash
   # Call the cron endpoint directly
   curl http://localhost:3000/api/cron/minutely
   ```

2. **Mock Data Characteristics:**
   - Solar production follows a realistic daily curve (0W at night, peaks at noon)
   - Consumption varies randomly between 500-2500W
   - Battery charges when solar > consumption
   - Grid supplements when needed
   - All values update each poll

3. **Verify Data Storage:**
   ```sql
   -- Check latest readings
   SELECT * FROM readings 
   WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'enphase')
   ORDER BY inverter_time DESC 
   LIMIT 5;
   ```

### 3. Testing Daylight-Only Polling

The mock respects the daylight-only polling rules:

1. **Test During "Daylight" (5 AM - 8 PM local):**
   - Polling occurs only at :00 and :30
   - Other times are skipped

2. **Test Outside "Daylight":**
   - All polls are skipped with log message

3. **Monitor Logs:**
   ```bash
   # Watch for ENPHASE prefixed messages
   npm run dev | grep ENPHASE
   ```

### 4. Testing Token Refresh

The mock simulates token expiration:

1. **Force Token Expiration:**
   - Tokens are valid for 24 hours in mock
   - System automatically refreshes when < 1 hour remaining

2. **Verify Refresh:**
   - Check logs for "ENPHASE: Token expiring soon, refreshing..."
   - New tokens are generated and stored

### 5. Testing Disconnection

1. **Disconnect System:**
   - Open Settings modal
   - Click "Disconnect Enphase System"
   - Confirm the action

2. **Verify Removal:**
   - System should show as disconnected
   - Tokens removed from Clerk metadata
   - System deactivated in database

## Mock Behavior Details

### Mock Telemetry Data

The mock generates realistic data based on time of day:

```javascript
// Solar: 0W at night, peaks at noon (up to 5kW)
// Consumption: 500-2500W random
// Battery: Charges from excess solar, discharges when needed
// Grid: Supplements when solar + battery insufficient
// SOC: Varies between 20-80%
```

### Mock Systems

Default mock system:
- System ID: `mock_system_001`
- Name: `Mock Solar System`
- Location: Melbourne, Australia
- Size: 5kW

### Mock API Responses

All mock responses include:
- Realistic delays (100ms)
- Proper error handling
- Consistent data structures
- ENPHASE-prefixed logging

## Debugging

### Enable Detailed Logging

All Enphase operations log with `ENPHASE:` prefix:

```bash
# Filter logs
npm run dev 2>&1 | grep "ENPHASE:"
```

### Common Log Messages

```
ENPHASE: Mock client initialized for testing
ENPHASE: Connect endpoint called
ENPHASE MOCK: Generated authorization URL
ENPHASE MOCK: Exchanging code for tokens
ENPHASE MOCK: Fetching systems
ENPHASE MOCK: Generating telemetry for system
ENPHASE: Poll successful - Solar: 2500 W Load: 1200 W
ENPHASE: Outside daylight hours, skipping poll
ENPHASE: Not on 30-minute boundary, skipping poll
```

### Database Verification

```sql
-- Check Enphase systems
SELECT * FROM systems WHERE vendor_type = 'enphase';

-- Check polling status
SELECT * FROM polling_status 
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'enphase');

-- Check readings
SELECT 
  datetime(inverter_time, 'unixepoch') as time,
  solar_w, load_w, battery_w, battery_soc
FROM readings 
WHERE system_id IN (SELECT id FROM systems WHERE vendor_type = 'enphase')
ORDER BY inverter_time DESC 
LIMIT 10;
```

## Testing Checklist

- [ ] **OAuth Flow**
  - [ ] Can initiate connection
  - [ ] Mock auth redirects properly
  - [ ] System created in database
  - [ ] Tokens stored in Clerk

- [ ] **Data Collection**
  - [ ] Telemetry fetched successfully
  - [ ] Data mapped correctly to schema
  - [ ] Readings stored in database
  - [ ] Aggregations updated

- [ ] **Polling Rules**
  - [ ] Only polls at :00 and :30
  - [ ] Skips outside daylight hours
  - [ ] Selectronic systems unaffected

- [ ] **Token Management**
  - [ ] Tokens refresh before expiry
  - [ ] Expired tokens handled gracefully

- [ ] **Error Handling**
  - [ ] Network errors logged
  - [ ] Invalid tokens trigger refresh
  - [ ] Polling errors recorded

- [ ] **UI Integration**
  - [ ] Settings modal shows correct status
  - [ ] Connect/disconnect flows work
  - [ ] Error messages display properly

## Switching to Production

1. **Set Real Credentials:**
   ```bash
   ENPHASE_API_KEY=your_real_api_key
   ENPHASE_CLIENT_ID=your_real_client_id
   ENPHASE_CLIENT_SECRET=your_real_client_secret
   ENPHASE_REDIRECT_URI=https://yourdomain.com/api/auth/enphase/callback
   ```

2. **Disable Mock Mode:**
   ```bash
   # Remove or set to false
   ENPHASE_USE_MOCK=false
   ```

3. **Test with Real System:**
   - Need actual Enphase system owner to authorize
   - Real data will be fetched and stored
   - Rate limits apply (1000 calls/month on Watt plan)

## Troubleshooting

### Mock Not Working

1. Check environment variables
2. Verify `NODE_ENV=development`
3. Check import paths are correct
4. Look for initialization logs

### No Data Appearing

1. Check polling window (must be :00 or :30)
2. Verify system has `vendor_type='enphase'`
3. Check cron job is running
4. Look for error logs

### OAuth Flow Fails

1. Verify callback URL matches
2. Check state parameter handling
3. Ensure Clerk is configured
4. Review redirect logic