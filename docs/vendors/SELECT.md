# Selectronic SP PRO / select.live API Documentation

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

1. **Session Management**: Sessions expire after inactivity. Need to re-authenticate when requests fail with 401.

2. **Rate Limiting**: The API appears to have undocumented rate limits. Implement exponential backoff.

3. **Magic Window Bug**: There's a known issue where the API returns 500 errors during minutes 48-52 of each hour. During this window, cache the last known good data.

```typescript
// Handle the "magic window" bug
const now = new Date();
const minute = now.getMinutes();

if (minute >= 48 && minute <= 52) {
  // Return cached data during the problematic window
  return lastKnownGoodData;
}
```

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

## Error Handling

### Common Error Codes

- **401 Unauthorized**: Session expired, need to re-authenticate
- **404 Not Found**: Invalid system number
- **500 Internal Server Error**: Server error or "magic window" bug
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

      if (response.status === 500) {
        const minute = new Date().getMinutes();
        if (minute >= 48 && minute <= 52) {
          // Magic window - use cached data
          throw new Error("Magic window period - use cache");
        }
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
    // Check for magic window
    const minute = new Date().getMinutes();
    if (minute >= 48 && minute <= 52) {
      throw new Error("API unavailable during magic window (48-52 minutes)");
    }

    // Ensure authenticated
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

5. **Multiple Systems**: If an account has multiple systems, each needs to be queried separately with its system number.

## Alternative Access Methods

1. **Local Network Access**: SP PRO devices on firmware 2.0+ expose a local JSON endpoint on port 3000 that doesn't require authentication.

2. **Modbus TCP**: SP PRO supports Modbus TCP for local network access (requires configuration).

3. **Serial/RS232**: Direct serial connection for local monitoring (requires physical access).

## References

- [Selectronic SP PRO Manual](https://www.selectronic.com.au/manuals/)
- [select.live Portal](https://select.live)
- [Home Assistant Integration Discussion](https://community.home-assistant.io/t/using-selectronic-sp-pro-select-live-data-in-the-energy-dashboard/417346)
