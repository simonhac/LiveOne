# Selectronic SP PRO / select.live API Documentation

> **Status:** current — legacy vendor, still in service.

## Overview

The Selectronic SP PRO inverters can be monitored remotely through the select.live web portal. This document describes how to programmatically access the API to retrieve real-time inverter data.

## API Endpoints

### Base URL

```
https://select.live
```

### Authentication Endpoint

```
POST https://select.live/login
```

### Data Endpoint

```
GET https://select.live/dashboard/hfdata/{system_number}
```

## Authentication Flow

The select.live API uses session-based authentication with cookies:

```typescript
// 1. Login with credentials
const loginResponse = await fetch("https://select.live/login", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    email: "user@example.com",
    password: "password123",
  }),
  credentials: "include", // Important: include cookies
});

// 2. Extract session cookie from response
const cookies = loginResponse.headers.get("set-cookie");

// 3. Use session cookie for subsequent requests
const dataResponse = await fetch(
  `https://select.live/dashboard/hfdata/${systemNumber}`,
  {
    headers: {
      Cookie: cookies,
    },
  },
);
```

## Data Structure

### Response Format

The API returns JSON with real-time inverter data:

```json
{
  "solarinverter_w": 3500, // Solar generation in watts
  "load_w": 2100, // Load consumption in watts
  "battery_soc": 85, // Battery state of charge (%)
  "grid_w": -500, // Grid power (negative = export)
  "battery_w": 1000, // Battery power (positive = charging)
  "battery_v": 52.4, // Battery voltage
  "inverter_temp": 45, // Inverter temperature (°C)
  "solar_v": 380, // Solar array voltage
  "solar_a": 9.2, // Solar array current
  "grid_v": 240, // Grid voltage
  "grid_hz": 50.0, // Grid frequency
  "inverter_mode": "AUTO", // Operating mode
  "alarms": [], // Active alarms
  "warnings": [] // Active warnings
}
```

## Implementation Details

### Authentication Challenges

The select.live authentication has some quirks that need to be handled:

1. **Session Management**: the session cookie lives in a private Map inside
   `SelectronicFetchClient`, so the ADAPTER caches the client (`SelectronicAdapter.clientCache`)
   to keep it across polls, re-authenticating once `sessionAgeMs()` passes
   `SELECTRONIC_SESSION_TTL_MS` (20 min against a ~30 min server session). A client whose session
   the portal rejects (`errorKind: "auth"`) is evicted; an upstream failure that says nothing about
   the session — a 504, a reset — is not.

   🛑 Cache the CLIENT, not a flag. The previous cache stored the string `"authenticated"` and was
   never read back, so every poll built a cookieless client and the client's own
   `cookies.size === 0` guard logged in again: measured on prod, **57 fetches produced 57 logins**,
   49 of them on polls where the cache had "hit". That is ~1440 logins/day where ~44 suffice (one
   per Vercel process lifetime, ~33 min).

2. **Rate Limiting**: The API appears to have undocumented rate limits. Implement exponential backoff.

3. **Availability windows** — measured over 30 days to 2026-09-16, one device, 0.31% overall
   failure rate (136 of ~43,200 polls). Two patterns, and **neither is the "magic window" this doc
   used to describe**:

   - **Daily rollover, 00:00-00:20 Sydney.** 75% of all failures: `HTTP 504 Gateway Timeout`, a
     consistent ~2.05 s, peaking hard at 00:15-00:17. Undocumented until now, and by far the
     bigger of the two. Not special-cased in code — the minutely poll re-attempts and a single
     missed interval is cheap.
   - **Minute ~50 of each hour**, the residue of the old 48-52 window. Minutes 48, 49 and 51 now
     have **zero** failures and minute 52 matches the all-hours baseline; only minute 50 shows
     anything, at 3.4%. Those failures are `Authentication failed` and `socket hang up` — the
     portal declining to LOG YOU IN, not declining to serve data, which is why session reuse
     matters more here than any window handling.

### Proxy Authentication Service

Due to CORS and authentication complexities, the original implementation uses a proxy service:

```python
# SelectLoginServ.py - Proxy authentication service
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route('/proxy/login', methods=['POST'])
def proxy_login():
    """
    Proxy login to handle authentication challenges
    """
    session = requests.Session()

    # Initial login
    login_data = {
        'email': request.json['email'],
        'password': request.json['password']
    }

    response = session.post(
        'https://select.live/login',
        data=login_data,
        allow_redirects=True
    )

    if response.status_code == 200:
        # Return session cookie
        return jsonify({
            'success': True,
            'cookie': session.cookies.get_dict()
        })

    return jsonify({'success': False}), 401
```

## Data Fields Reference

| Field             | Description                               | Unit       | Range                   |
| ----------------- | ----------------------------------------- | ---------- | ----------------------- |
| `solarinverter_w` | Solar generation power                    | Watts      | 0 - max inverter rating |
| `load_w`          | Load consumption                          | Watts      | 0 - max load            |
| `battery_soc`     | Battery state of charge                   | Percentage | 0 - 100                 |
| `battery_w`       | Battery power (+ charging, - discharging) | Watts      | -max to +max            |
| `battery_v`       | Battery voltage                           | Volts      | Varies by battery type  |
| `battery_a`       | Battery current                           | Amps       | Varies by system        |
| `grid_w`          | Grid power (+ import, - export)           | Watts      | -max to +max            |
| `grid_v`          | Grid voltage                              | Volts      | Typically 230-250V      |
| `grid_hz`         | Grid frequency                            | Hertz      | 49.5 - 50.5 Hz          |
| `inverter_temp`   | Inverter temperature                      | Celsius    | 0 - 80°C                |
| `inverter_mode`   | Operating mode                            | String     | AUTO, BACKUP, etc.      |
| `solar_v`         | Solar array voltage                       | Volts      | 0 - max MPPT voltage    |
| `solar_a`         | Solar array current                       | Amps       | 0 - max MPPT current    |

## Fault reporting: three sources, and why one is not enough

🛑 **`fault_code: 0` from `/dashboard/hfdata` is not evidence that nothing happened.** Across the
three Daylesford power interruptions of 17–18 September 2026, all 126 successful samples reported
zero, while the inverter had logged code 50 (Instant Low DC Voltage Fault) and code 127 (Main DC
Supply Cable Open Circuit Fault). The field is a sample of an instant; a fault that begins and ends
between two polls leaves no trace in it, and the poll also fails during the interruptions that
matter most.

| Source | What it gives | Clock | Retained where |
| --- | --- | --- | --- |
| `GET /dashboard/hfdata/{id}` | `fault_code`, `fault_ts` — the fault active right now, if any | vendor Unix seconds | the `fault_code` / `fault_ts` points |
| `GET /events/{id}` | the portal's retained list, with paired **Created** and **Cleared** | the portal account's timezone | `device_events`, `source = 'portal'` |
| SP LINK tunnel, `select.live:7528` | every fault AND state change, each with an electrical snapshot, from two logs | the inverter's own clock | `device_events`, `source = 'inverter'` |

The Events page renders its rows server-side; there is no separate JSON endpoint (its search box
filters the rendered table client-side). Parsing lives in
`lib/vendors/selectronic/portal-events.ts`, and an unrecognisable page — a login redirect, a missing
table — is reported as **unavailable data**, never as an empty event history. An empty history would
clear a fault that is still active.

The inverter's own logs are `lib/selectlive/events.ts`; see
[the Select.live CLI notes](./selectlive-cli.md#event-logs).

🛑 **The two sources are never merged, however well their codes match.** On 18 September the portal
displayed a low-DC clearance at 12:12:59 while the inverter recorded 12:02:12 on its own clock,
which measured ~46 s slow. A portal occurrence is one row, updated in place when its Cleared value
appears; an inverter fault and its clearance are two records and stay two rows.

### What the two fault points now mean

Resolved together by `resolveFaultPoints` (`lib/vendors/selectronic/diagnostics.ts`):

- **`fault_code`** — a fresh nonzero code from the readings wins; otherwise the newest *active*
  inverter event the Events page shows; otherwise **0**, written explicitly. Zero is what clears a
  previous fault: a null would leave the last nonzero code standing as the latest value for ever.
  That includes the **default** case — a device with `portalEvents` off still publishes the
  vendor's own zero, exactly as it did before this feature existed.
  Null is reserved for "we genuinely do not know this minute": the Events page was enabled but
  unreadable, or only *partly* readable and showed no active fault (the row that failed to parse
  might have been the active one). An active fault the page *did* show is trusted even from a
  partial parse.
- **`fault_ts`** — "Last Fault Time": the newest known fault OCCURRENCE, retained after clearance,
  so a fault that came and went between two polls still leaves a trace. Portal occurrences use
  **Created**, never Cleared. It is in epoch **milliseconds**, which is what the point declares; the
  vendor field is Unix seconds and was previously fed through unconverted.

Both are gated per device by `config.diagnostics.portalEvents`; the automatic acquisition of the
inverter's internal logs is gated separately by `config.diagnostics.autoAcquire`, and performed by
`/api/cron/diagnostics`. The whole fault leg is bounded by `FAULT_LEG_BUDGET_MS` (10 s) so it can
never spend the poll's budget after the readings are already in hand, and retention + enqueue run
in one transaction — storing the row *consumes* the transition, so a failure between the two would
lose the acquisition request silently and for ever.

### What triggers an acquisition

A newly observed inverter fault on the Events page (including one first seen already cleared), the
clearance of one we held as active, and a change in the polled `fault_code` to a nonzero value.
🛑 That last one is an **in-process memo** and is deliberately lossy: the first sighting after a
cold start *seeds* it without firing, because the alternative is re-firing an acquisition for the
same persistent fault on every restart. The memo advances only once the transition has been acted
on, so a failed poll re-detects it next minute rather than consuming it; and it fires even when the
Events page is unreadable, because the minute an inverter faults is the minute the portal is most
likely to be unreachable. An *absent* `fault_code` is unknown, never a zero. The durable path
remains the Events page, whose transitions are computed against stored rows. Portal code 1001
("no updates for more than 24 hours") describes our link to the portal, not the plant, and never
triggers.

## Error Handling

### Common Error Codes

- **401 Unauthorized**: Session expired, need to re-authenticate
- **404 Not Found**: Invalid system number
- **500 Internal Server Error**: Server error
- **504 Gateway Timeout**: overwhelmingly the 00:00-00:20 Sydney rollover (see above)
- **503 Service Unavailable**: System offline or maintenance

### Retry Strategy

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 401) {
        // Re-authenticate and retry
        await authenticate();
        continue;
      }

      if (response.ok) {
        return response;
      }
    } catch (error) {
      if (i === maxRetries - 1) throw error;

      // Exponential backoff
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, i) * 1000),
      );
    }
  }
}
```

## Complete Implementation Example

```typescript
// lib/selectronic/client.ts
import { cookies } from "next/headers";

interface SelectronicCredentials {
  email: string;
  password: string;
  systemNumber: string;
}

interface SelectronicData {
  solarPower: number;
  loadPower: number;
  batterySOC: number;
  gridPower: number;
  batteryPower: number;
  timestamp: Date;
}

class SelectronicClient {
  private sessionCookie?: string;
  private lastAuth?: Date;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  constructor(private credentials: SelectronicCredentials) {}

  private async authenticate(): Promise<void> {
    const response = await fetch("https://select.live/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: this.credentials.email,
        password: this.credentials.password,
      }),
    });

    if (!response.ok) {
      throw new Error("Authentication failed");
    }

    this.sessionCookie = response.headers.get("set-cookie") || undefined;
    this.lastAuth = new Date();
  }

  private isSessionValid(): boolean {
    if (!this.sessionCookie || !this.lastAuth) return false;

    const elapsed = Date.now() - this.lastAuth.getTime();
    return elapsed < this.SESSION_TIMEOUT;
  }

  async fetchData(): Promise<SelectronicData> {
    // Ensure authenticated — the session, not the clock, is what to check.
    if (!this.isSessionValid()) {
      await this.authenticate();
    }

    // Fetch data
    const response = await fetch(
      `https://select.live/dashboard/hfdata/${this.credentials.systemNumber}`,
      {
        headers: {
          Cookie: this.sessionCookie!,
        },
      },
    );

    if (response.status === 401) {
      // Session expired, re-authenticate and retry
      await this.authenticate();
      return this.fetchData();
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch data: ${response.status}`);
    }

    const data = await response.json();

    return {
      solarPower: data.solarinverter_w || 0,
      loadPower: data.load_w || 0,
      batterySOC: data.battery_soc || 0,
      gridPower: data.grid_w || 0,
      batteryPower: data.battery_w || 0,
      timestamp: new Date(),
    };
  }
}

export default SelectronicClient;
```

## Testing

To test the API connection:

```bash
# Test authentication
curl -X POST https://select.live/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=user@example.com&password=password123" \
  -c cookies.txt

# Test data fetch
curl https://select.live/dashboard/hfdata/YOUR_SYSTEM_NUMBER \
  -b cookies.txt
```

## Important Notes

1. **System Number**: Each SP PRO installation has a unique system number visible in the select.live dashboard URL when logged in.

2. **Polling Frequency**: Respect the service by polling no more than once per minute. The data typically updates every 30-60 seconds.

3. **CORS Issues**: The select.live API doesn't support CORS headers, so browser-based requests won't work directly. Use a backend/proxy service.

4. **Data Availability**: Historical data access requires different endpoints not documented here.
   The inverter's own retained history — 15-minute measurements, and the two event logs — is
   reachable over the SP LINK tunnel instead; see [selectlive-cli.md](./selectlive-cli.md).

5. **Multiple Systems**: If an account has multiple systems, each needs to be queried separately with its system number.

## Alternative Access Methods

1. **Local Network Access**: SP PRO devices on firmware 2.0+ expose a local JSON endpoint on port 3000 that doesn't require authentication.

2. **Modbus TCP**: SP PRO supports Modbus TCP for local network access (requires configuration).

3. **Serial/RS232**: Direct serial connection for local monitoring (requires physical access).

## References

- [Selectronic SP PRO Manual](https://www.selectronic.com.au/manuals/)
- [select.live Portal](https://select.live)
- [Home Assistant Integration Discussion](https://community.home-assistant.io/t/using-selectronic-sp-pro-select-live-data-in-the-energy-dashboard/417346)
