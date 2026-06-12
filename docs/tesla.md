# Tesla Integration

> **Status:** current — in-app Owner API onboarding (redirect + paste-back).

## Overview

Users add a Tesla from the **Add System** dialog. The adapter polls vehicle data:

- Battery SoC
- Charging state (Disconnected, Charging, Complete, etc.)
- Charge power, current, rate
- Time to full charge
- Speed
- Odometer

**Polling intervals:**

- Default: 15 minutes
- When charging: 5 minutes

## How onboarding works (Owner API, no local tooling)

Tesla is onboarded via the legacy **`ownerapi`** OAuth client, which only ever redirects to
`https://auth.tesla.com/void/callback` — Tesla does **not** allow a custom redirect URI for it. So we
can't bounce the user straight back into the app; instead we use a **redirect + paste-back** flow:

1. In **Add System**, the user picks **Tesla** and clicks **Connect with Tesla**.
2. `POST /api/auth/tesla/connect` generates PKCE + a random `state`, stores the `code_verifier` in
   Vercel KV (`tesla:oauth:<state>`, 15-min TTL, bound to the Clerk user), and returns the Tesla
   authorization URL. The verifier never reaches the browser.
3. Tesla's login opens in a new tab. The user signs in (handling their own MFA/captcha) and lands on a
   blank **"Page Not Found"** at `auth.tesla.com/void/callback?code=…`.
4. The user copies that page's URL and pastes it back into the dialog → `POST /api/auth/tesla/complete`.
5. The server validates the URL host, looks up the verifier by `state` (single-use), exchanges the code
   for tokens (`client_id=ownerapi`, no secret), discovers vehicles via the Owner API
   (`owner-api.teslamotors.com/api/1/products`), creates the `tesla` system, and stores the tokens in
   Clerk. Multiple vehicles → the dialog shows a picker (tokens stashed briefly under
   `tesla:pending:<token>`).

This works identically in development and production — there are no Tesla env vars or local files
involved. (Access tokens last ~8h and are auto-refreshed via the `ownerapi` refresh grant in
`lib/vendors/tesla/tesla-auth.ts`.)

## Data Points

| Field                | Logical Path              | Type      | Unit    |
| -------------------- | ------------------------- | --------- | ------- |
| Battery SoC          | `ev.battery/soc`          | soc       | %       |
| Charge Limit         | `ev.charge.limit/soc`     | soc       | %       |
| Plugged In           | `ev.charge/engaged`       | engaged   | boolean |
| Charging State       | `ev.charge/state`         | state     | text    |
| Charge Limit Current | `ev.charge.limit/current` | current   | A       |
| Charge Current       | `ev.charge/current`       | current   | A       |
| Charge Power         | `ev.charge/power`         | power     | kW      |
| Charge Rate          | `ev.charge/rate`          | rate      | mi/hr   |
| Time to Full         | `ev.charge/remaining`     | remaining | hours   |
| Speed                | `ev/speed`                | speed     | mph     |
| Odometer             | `ev/odometer`             | odometer  | miles   |

> Location (lat/lon) is fetched in `vehicle_data` but not yet stored as a point.

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
2. If asleep, sends `wake_up`
3. Waits up to 30 seconds for the vehicle to come online
4. Skips the poll if the vehicle doesn't wake (preserves the 12V battery)

## Files

- `lib/vendors/tesla/adapter.ts` — polling adapter (15/5-min schedule, wake-up, point extraction)
- `lib/vendors/tesla/tesla-sso-client.ts` — `ownerapi` OAuth (authorize/exchange/refresh, no secret)
- `lib/vendors/tesla/tesla-owner-client.ts` — Owner API data calls (`owner-api.teslamotors.com`)
- `lib/vendors/tesla/tesla-auth.ts` — token storage + auto-refresh
- `lib/vendors/tesla/tesla-oauth-state.ts` — KV-backed PKCE state for the paste-back flow
- `lib/vendors/tesla/point-metadata.ts` — data point definitions
- `lib/vendors/tesla/types.ts` — TypeScript interfaces
- `app/api/auth/tesla/connect` · `complete` · `disconnect` — onboarding routes
- `components/TeslaConnectFlow.tsx` — the in-dialog connect UI
- `components/TeslaSmallCard.tsx` — dashboard battery/charge card

## Fleet API (not used)

`lib/vendors/tesla/tesla-client.ts` and `app/api/auth/tesla/callback` implement the modern **Fleet API**
OAuth path (requires `TESLA_CLIENT_ID`/`TESLA_CLIENT_SECRET`/`TESLA_REDIRECT_URI`, partner registration,
and a `.well-known` public key). They're left in place as the basis for a future Fleet option but are
**not wired** into onboarding. If pursued, fix the hardcoded NA region in `tesla-client.ts`
(`FLEET_API_BASE_URL`) via `/api/1/users/region` discovery.
