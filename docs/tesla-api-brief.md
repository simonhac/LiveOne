# Brief: Tesla vehicle API — status & charge-control path (June 2026)

> Status: current — decision brief driving the Owner API → Fleet API re-platform.
> Implementation plan tracked separately; see `docs/tesla.md` for the adapter spec.

**Goal:** Send charge commands (`START_CHARGE`, `STOP_CHARGE`, `CHANGE_CHARGE_LIMIT`, `CHARGING_AMPS`) — first to a pre-2021 Model X, later to other Teslas.

**Bottom line:** The legacy **Owner API** auth is dead (the redirect it relied on is no longer registered). The **Fleet API** is the only supported path; the charge-command _endpoint names are identical_, so the REST shape barely changes. The real variable is **command signing**: pre-2021 Model S/X are **exempt** (plain REST works), but **2021+ cars require a virtual key + signed commands**. Plan for both.

---

## 1. What changed

Tesla retired the unofficial **Owner API** (`client_id=ownerapi`). The historic OAuth redirect `https://auth.tesla.com/void/callback` is no longer registered, so the SSO authorize endpoint now returns:

> `The 'redirect_uri' supplied is not registered for this 'client_id'.`

This is a structural deprecation (confirmed across TeslaMate #5296 Apr 2026, Tessie status page, TeslaPy #150), not an outage. Tools built on the Owner API (`teslapy`, tezman) fail out of the box.

- **Fragile stopgap:** the `ownerapi` client still accepts the legacy mobile-app redirect **`tesla://auth/callback`** (merged into `tesla_auth` PR #99, working Apr–May 2026). It re-enables Owner API auth, but it's on borrowed time, tokens expire ~3 months, and Tesla can de-register it at any point. Use only to unblock — not as a foundation.

## 2. The Fleet API is the supported path

Tesla declared Fleet API "the only supported API for vehicle interactions" and warns that continued use of unsupported endpoints **revokes Fleet access**. Setup:

1. Register an app at `developer.tesla.com` (MFA account) → `client_id` + `client_secret`.
2. Host your **public key** at `https://<your-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem` and register a **partner account** (one-time `client_credentials` partner token → `POST /api/1/partner_accounts`). Required even for read-only.
3. OAuth per user: `authorization_code` + PKCE → access/refresh tokens.
4. **Regional base URL matters** — e.g. `fleet-api.prd.na.vn.cloud.tesla.com` (NA). Confirm the correct region host for AU accounts; don't assume NA.
5. **Billing:** pay-per-use since Jan 1 2025 (accrual ~Feb 2025). Requests with status < 500 are billable; ≥ 500 are not. A **~$10/month per-account discount** covers light use (≈ data streaming + 100 commands + 2 wakes/day for two vehicles). Configure a billing method or calls are rejected.

**OAuth scopes for charge control:** `openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds` (the charge commands all live under `vehicle_charging_cmds`; `vehicle_location` is separately required for location since 2025).

## 3. The charge commands map 1:1 — names don't change

Fleet API uses the same `POST /api/1/vehicles/{id}/command/{name}` shape as the Owner API. Only the **base URL** (regional Fleet host) and the **signing requirement** differ.

| Intent            | Command name (Owner _and_ Fleet) | Body                       |
| ----------------- | -------------------------------- | -------------------------- |
| Start charging    | `command/charge_start`           | —                          |
| Stop charging     | `command/charge_stop`            | —                          |
| Set charge limit  | `command/set_charge_limit`       | `{ "percent": <50–100> }`  |
| Set charging amps | `command/set_charging_amps`      | `{ "charging_amps": <n> }` |

Reads (`vehicle_data`) and `wake_up` are **never** signed commands — they work on any car with just a valid token. Signing only applies to the `command/*` calls above.

## 4. The one thing that actually varies: command signing

Command signing (Tesla **Vehicle Command protocol**) is enforced by the **car's keychain**, independent of which API you call.

- **Pre-2021 Model S/X — EXEMPT.** They don't implement the protocol, so they accept **unsigned** charge commands over plain Fleet REST. No virtual key, no proxy. → _Your Model X works with a direct `fetch` to the command endpoint._
- **2021+ cars — REQUIRED.** Charge commands must be **signed**. That means:
  1. Enroll a per-vehicle **virtual key** (owner adds your app's key to the car).
  2. Sign commands via Tesla's **Vehicle Command SDK** or run **`tesla-http-proxy`** (transforms REST commands into signed ones — point your client at the proxy, no app code change).
     Unsigned `command/*` calls to these cars return `403 Tesla Vehicle Command Protocol required`.

## 5. Recommended sequencing

- **Phase 1 — pre-2021 Model X (now):** Fleet API + OAuth + direct REST charge commands. No signing infra. This is the fast win.
- **Phase 2 — other Teslas (2021+):** add virtual-key enrollment in the connect flow + stand up `tesla-http-proxy` (or the SDK) so the same four commands get signed. Pre-2021 cars keep bypassing it.

Build the command layer so the **signing step is pluggable** (direct REST for exempt cars, proxy for the rest) — then Phase 2 is config + infra, not a rewrite.

## 6. Risks / watch-items

- `tesla://auth/callback` Owner-API workaround is temporary — migrate off it.
- Verify the **AU regional Fleet host** before first prod call (code commonly hardcodes NA).
- Don't skip **partner public-key hosting** — Fleet auth fails silently-ish without it.
- Watch per-command **billing** at scale; tune polling/command cadence.
- State as of **June 2026**; `developer.tesla.com/docs/fleet-api/announcements` is the source of truth.

## 7. Sources

- `developer.tesla.com/docs/fleet-api/announcements` (legacy-endpoint shutdown 2024-03-26; signing deprecation 2023-11-17; billing 2024-11-27)
- `developer.tesla.com/docs/fleet-api/virtual-keys/overview`; `github.com/teslamotors/vehicle-command` (proxy/SDK, pre-2021 exemption)
- TeslaMate #5296 (redirect_uri error); `tesla_auth` PR #99 (`tesla://auth/callback` fix); Tessie status page; TeslaPy #150
- `developer.tesla.com/docs/fleet-api/authentication/{overview,partner-tokens,third-party-tokens}`

_(Compiled from a multi-source, adversarially-verified research pass; high-confidence findings corroborated across ≥2 independent sources.)_
