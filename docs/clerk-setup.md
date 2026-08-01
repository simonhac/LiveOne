# Clerk setup

> **Status:** current — last verified 2026-08-01.
> Configuration and one-time setup for Clerk. The **authorization model** — who may read or write
> what, and the edge/share-token boundary — is
> [`architecture/authentication.md`](architecture/authentication.md).

LiveOne uses [Clerk](https://clerk.dev) for authentication, session management and user storage. We
write no auth code of our own; what follows is the configuration that the app assumes exists.

## Environment variables

```bash
# Clerk keys
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx

# Redirect URLs
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/setup

# Admin fallback (comma-separated Clerk user IDs) — see "Session claims" below
ADMIN_USER_IDS=user_xxx,user_yyy
```

⚠️ **Vercel preview authenticates against the _production_ Clerk instance** while pointing at the
`liveone-dev` database. That combination is deliberate (it is what makes a preview URL shareable),
but it means a preview user's Clerk id is the prod id while `liveone-dev`'s config rows are reowned
to the dev id — which is why the dashboard-grant leg of `devicesVisibleByUser` is load-bearing rather
than vestigial. See [`architecture/authentication.md`](architecture/authentication.md).

## Session claims — configure this, it is a real latency win

Admin checks happen on every `/api/admin/*` request. Resolved from a session claim they are free;
resolved by falling back to a Clerk API call they cost a network round-trip:

| Path                                    | Cost         |
| --------------------------------------- | ------------ |
| `sessionClaims.isPlatformAdmin` present | ~0 ms (JWT)  |
| Fallback: `clerkClient().users.getUser` | ~150 ms      |

The fallback is not dead code — it is what runs when the claim is missing, and it shows up as the
`admin` span in the `Server-Timing` header (`lib/api-auth.ts` instruments the two Clerk costs
separately for exactly this reason). If that span is costing real time in production, the claim below
is not configured.

**Setup (Clerk Dashboard):** Sessions → *Customize session token* → add:

```json
{
  "isPlatformAdmin": "{{user.public_metadata.isPlatformAdmin}}"
}
```

The token refreshes automatically (~60s), so granting or revoking admin takes effect within a minute
without a sign-out.

## Public vs private metadata

- **Public metadata** — visible in the JWT and to the frontend. Roles and other non-sensitive flags:
  `isPlatformAdmin` lives here.
- **Private metadata** — server-side only, encrypted at rest, never exposed to the browser. **All
  vendor credentials live here**, per owning user (locked decision, 2026-06-06 — the rationale is in
  [`architecture/engine-web-separation.md`](architecture/engine-web-separation.md) §3).

```typescript
const client = await clerkClient();
await client.users.updateUserMetadata(userId, {
  publicMetadata: { isPlatformAdmin: true },
  privateMetadata: {
    selectronic: { username: "…", password: "…", siteId: "1586" },
    enphase: { accessToken: "…", refreshToken: "…", expiresAt: 1234567890 },
    fronius: { deviceId: "…", apiKey: "…" },
    // amber, sigenergy, tesla follow the same per-vendor shape
  },
});
```

Read them through `getSystemCredentials` (`lib/secure-credentials.ts`) rather than reaching for
`clerkClient()` directly — that function is the seam the engine/web split depends on.

Because credentials are keyed by **owner**, any job that fetches on a user's behalf needs that user's
Clerk record. A dev run of something like coverage repair therefore needs the **prod**
`CLERK_SECRET_KEY` to reach real Amber/Sigenergy credentials; vendors on a global key
(OpenElectricity) are unaffected.

## Dashboard policy

Set in the Clerk Dashboard, not in code, so they are recorded here rather than being discoverable
from the repo:

- **Passwords** — min 8 characters, upper + lower + number + special, leak detection enabled.
- **Sessions** — 7-day session, 30-minute inactivity timeout, multi-session enabled.

## Getting a token for local API testing

`x-claude: true` authenticates as admin inside route handlers, but the Clerk middleware 404s
unauthenticated API calls at the edge before the handler runs — so it only works on public-listed
routes. For anything else, mint a real session JWT:

```bash
JWT=$(npx tsx scripts/utils/get-test-token.ts 2>/dev/null | grep -E '^eyJ' | head -1)
curl -H "Authorization: Bearer $JWT" http://localhost:3000/api/v4/areas
```

It expires in ~60 seconds, so mint it in the same command that uses it. This requires the target user
to have an active browser session on the dev Clerk instance.
