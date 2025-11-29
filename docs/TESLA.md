# Tesla Integration

## Overview

The Tesla adapter polls vehicle data including:

- Battery SoC
- Charging state (Disconnected, Charging, Complete, etc.)
- Charge power, current, rate
- Time to full charge
- Speed
- Location (lat/lon as JSON)

**Polling intervals:**

- Default: 15 minutes
- When charging: 5 minutes

## Environment Variables

```bash
TESLA_CLIENT_ID=<from Tesla developer portal>
TESLA_CLIENT_SECRET=<from Tesla developer portal>
TESLA_REDIRECT_URI=https://liveone.vercel.app/api/auth/tesla/callback
```

## Bootstrapping in Development

Since OAuth requires a public callback URL, use the bootstrap endpoint with your existing Python CLI credentials.

### Prerequisites

1. Have the Tesla Python CLI set up with valid credentials in `~/.tesla_cache.json`
2. Dev server running on `localhost:3000`
3. Be logged in to the app

### Steps

**1. Check if cached credentials exist:**

```bash
curl http://localhost:3000/api/admin/bootstrap-tesla
```

Response:

```json
{
  "found": true,
  "email": "your@email.com",
  "expiresAt": "2025-11-29T16:04:21.000Z",
  "isExpired": false
}
```

**2. If tokens are expired, refresh via Python CLI:**

```bash
cd /path/to/tezman
python tez.py --stats
```

This refreshes the tokens in `~/.tesla_cache.json`.

**3. Bootstrap the Tesla system:**

```bash
curl -X POST -H "x-claude: true" http://localhost:3000/api/admin/bootstrap-tesla
```

Response:

```json
{
  "success": true,
  "systemId": 5,
  "vehicleId": "1234567890",
  "vehicleName": "My Tesla",
  "vin": "5YJ3E1...",
  "state": "online",
  "message": "Tesla system bootstrapped successfully"
}
```

**4. Trigger a poll:**

```bash
curl -X POST -H "x-claude: true" "http://localhost:3000/api/cron/minutely?force=true"
```

## Production OAuth Flow

In production, users connect via the standard OAuth flow:

1. User clicks "Connect Tesla" button
2. Frontend calls `POST /api/auth/tesla/connect`
3. User redirected to `auth.tesla.com` to authorize
4. Tesla redirects to `/api/auth/tesla/callback`
5. Callback creates system, stores credentials
6. User redirected to `/auth/tesla/result`

## Data Points

| Field          | Logical Path          | Type     | Unit    |
| -------------- | --------------------- | -------- | ------- |
| Battery SoC    | `ev.battery/soc`      | soc      | %       |
| Plugged In     | `ev.charge/engaged`   | status   | boolean |
| Charging State | `ev.charge/state`     | status   | string  |
| Charge Current | `ev.charge/current`   | current  | A       |
| Charge Power   | `ev.charge/power`     | power    | kW      |
| Charge Rate    | `ev.charge/rate`      | rate     | mi/hr   |
| Time to Full   | `ev.charge/remaining` | duration | hours   |
| Speed          | `ev/speed`            | speed    | mph     |
| Location       | `ev/location`         | location | JSON    |

## Charging States

| State          | Description               |
| -------------- | ------------------------- |
| `Disconnected` | No cable connected        |
| `NoPower`      | Cable connected, no power |
| `Starting`     | Charging session starting |
| `Charging`     | Actively charging         |
| `Stopped`      | Charging paused           |
| `Complete`     | Reached charge limit      |

## Wake-up Handling

Tesla vehicles sleep to conserve battery. The adapter:

1. Checks vehicle state before fetching data
2. If asleep, sends wake_up command
3. Waits up to 30 seconds for vehicle to come online
4. Skips poll if vehicle doesn't wake (preserves 12V battery)

## Files

- `lib/vendors/tesla/adapter.ts` - Main adapter
- `lib/vendors/tesla/tesla-client.ts` - OAuth + API client
- `lib/vendors/tesla/tesla-auth.ts` - Token management
- `lib/vendors/tesla/point-metadata.ts` - Data point definitions
- `lib/vendors/tesla/types.ts` - TypeScript interfaces
- `app/api/auth/tesla/` - OAuth routes
- `app/api/admin/bootstrap-tesla/` - Dev bootstrap endpoint
