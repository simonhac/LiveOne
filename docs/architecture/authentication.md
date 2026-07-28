# LiveOne Authentication & Security

> **Status:** current — last verified 2026-06-10.

## Overview

LiveOne uses [Clerk](https://clerk.dev) for authentication, providing enterprise-grade security with minimal implementation overhead. Vendor credentials are stored securely in Clerk's private metadata, never in the database.

## Authentication Architecture

### Core Technology: Clerk

Clerk handles all authentication, session management, and user storage. We optimize performance using session claims to avoid API calls for permission checks.

**Key Benefits:**

- Zero auth code to maintain
- Pre-built UI components
- SOC 2 Type II certified
- Free up to 10,000 MAU
- Multi-factor authentication built-in
- User impersonation for support

### Implementation

```typescript
// app/layout.tsx
import { ClerkProvider } from '@clerk/nextjs';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

```typescript
// middleware.ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/health",
  "/api/push/fronius", // FroniusPusher webhook
]);

const isCronRoute = createRouteMatcher(["/api/cron/(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  // Allow public routes
  if (isPublicRoute(req)) return;

  // Cron routes require Bearer token (not Clerk auth)
  if (isCronRoute(req)) return;

  // Protect all other routes
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

## User Metadata & Permissions

### Public vs Private Metadata

- **Public Metadata**: Visible in JWT tokens and frontend (roles, limits, non-sensitive data)
- **Private Metadata**: Server-side only (vendor credentials, API keys, sensitive data)

```typescript
import { clerkClient } from "@clerk/nextjs/server";

// Update user metadata (admin only)
const client = await clerkClient();
await client.users.updateUserMetadata(userId, {
  publicMetadata: {
    isPlatformAdmin: true, // Session claim for instant access checks
  },
  privateMetadata: {
    // Vendor credentials stored encrypted
    selectronic: {
      username: "user@example.com",
      password: "encrypted_password",
      siteId: "1586",
    },
    enphase: {
      accessToken: "encrypted_token",
      refreshToken: "encrypted_token",
      expiresAt: 1234567890,
    },
    fronius: {
      deviceId: "device_uuid",
      apiKey: "encrypted_key",
    },
  },
});
```

### Session Claims for Performance

Configure session claims in Clerk Dashboard to eliminate API calls for permission checks.

**Setup (Clerk Dashboard):**

1. Navigate to: **Sessions → Customize session token**
2. Add custom claim:

```json
{
  "isPlatformAdmin": "{{user.public_metadata.isPlatformAdmin}}"
}
```

**Usage in code:**

```typescript
import { auth } from "@clerk/nextjs/server";

export async function GET(request: Request) {
  const { userId, sessionClaims } = await auth();

  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Check custom claims (0ms - data in JWT token)
  const isAdmin = sessionClaims?.isPlatformAdmin === true;

  if (!isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  // Process request...
}
```

**Performance:**

- Before optimization: ~150ms per admin check (API call to Clerk)
- After optimization: ~0ms per admin check (JWT claim)
- Token refresh: Every 60 seconds (automatic)

## Environment Variables

```bash
# .env.local (development)
# .env.production (Vercel)

# Clerk Authentication
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx

# Redirect URLs
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/setup

# Database (PostgreSQL on PlanetScale)
PLANETSCALE_DATABASE_URL=postgres://user:pass@host/db?sslmode=require

# Vercel KV Cache (optional)
KV_REST_API_URL=https://your-kv.kv.vercel-storage.com
KV_REST_API_TOKEN=your-token

# Cron Job Protection
CRON_SECRET=your-random-secret

# Admin Users (comma-separated Clerk user IDs)
ADMIN_USER_IDS=user_xxx,user_yyy
```

## System Ownership Model

### Database Schema

A system's only per-user link is **`systems.owner_clerk_user_id`** — one nullable owner. A NULL owner
means the system is **public**: readable by everyone, writable only by admins. See
`lib/db/planetscale/schema.ts` for the column set; it is the source of truth and is not reproduced here.

There is no per-system grant table. `user_systems` — the pre-Areas `owner`/`viewer` junction — was
dropped in migration **0045** (config-v4 Phase 12 slice F) with **no replacement**: sharing is
per-DASHBOARD, not per-system — `dashboard_grants` (per-person invite) and `share_tokens` (public
link), both enforced by `requireDashboardAccess`. See
[areas-and-dashboards.md](./areas-and-dashboards.md).

### Access Control

Nothing computes access ad hoc — everything routes through `lib/api-auth.ts`:

| Helper                     | Answers                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `requireSystemAccess`      | may this caller read/write this system? Returns a `SystemAuthContext`.      |
| `requireDashboardAccess`   | same question for a dashboard, and share-token aware (`userId` may be null) |
| `requireAdmin`             | platform admin only                                                        |
| `requireCronOrAdmin`       | cron secret or admin                                                       |

`SystemsManager.getSystemsVisibleByUser` (`lib/systems-manager.ts`) builds the device-switcher list:
systems the user **owns**, systems that are **public**, and systems a **dashboard grant** reaches (via
`grantedSystemScopeForUser`). That third leg used to be an inner join on `user_systems`; it was
re-pointed at `dashboard_grants` rather than deleted, because it is load-bearing for Vercel preview —
preview authenticates against the live prod Clerk instance while `liveone-dev`'s config is reowned to
the dev id.

## Client-Side Auth

```typescript
'use client';

import { useAuth, useUser } from '@clerk/nextjs';

export function DashboardHeader() {
  const { isLoaded, userId } = useAuth();
  const { user } = useUser();

  if (!isLoaded) {
    return <div>Loading...</div>;
  }

  if (!userId) {
    return <div>Please sign in</div>;
  }

  return (
    <div>
      <h1>Welcome {user?.firstName}!</h1>
      <p>{user?.emailAddresses[0]?.emailAddress}</p>
    </div>
  );
}
```

## Security Best Practices

### Clerk Dashboard Configuration

**Password Requirements:**

- Minimum 8 characters
- Require uppercase letter
- Require lowercase letter
- Require number
- Require special character
- Enable leak detection

**Session Settings:**

- Session timeout: 7 days
- Inactivity timeout: 30 minutes
- Multi-session: Enabled

### API Authorization Functions

LiveOne uses centralized authorization functions in `lib/api-auth.ts` for consistent access control across all API endpoints.

### Available Functions

```typescript
import {
  requireAuth,
  requireAdmin,
  requireCronOrAdmin,
  requireSystemAccess,
} from "@/lib/api-auth";
```

| Function              | Returns                | Use Case                          |
| --------------------- | ---------------------- | --------------------------------- |
| `requireAuth`         | `AuthenticatedContext` | Basic user authentication         |
| `requireAdmin`        | `AuthenticatedContext` | Admin-only endpoints              |
| `requireCronOrAdmin`  | `AuthContext`          | Cron jobs (Bearer token) or admin |
| `requireSystemAccess` | `SystemAuthContext`    | System-level access checks        |

### Context Types

```typescript
// Basic auth context
interface AuthContext {
  userId: string | null;
  isAdmin: boolean;
  isCron: boolean;
  isClaudeDev: boolean;
}

// Successful auth (userId guaranteed)
interface AuthenticatedContext extends AuthContext {
  userId: string;
}

// System access context
interface SystemAuthContext extends AuthenticatedContext {
  system: SystemWithPolling;
  isOwner: boolean;
  canRead: boolean;
  canWrite: boolean;
}
```

### Usage Pattern

All auth functions return either the context object or a `NextResponse` error. Use this pattern:

```typescript
import { requireAdmin } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  // Check authorization
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  // authResult.userId is now guaranteed to be a string
  const { userId, isAdmin } = authResult;

  // Process request...
}
```

### Authentication Methods

The auth functions support multiple authentication methods:

1. **Clerk Authentication** - Standard user login via Clerk
2. **Bearer Token** - For cron jobs using `CRON_SECRET`
3. **Claude Dev Header** - Development bypass with `x-claude: true` header

### System Access Checks

For endpoints that access system data, use `requireSystemAccess`:

```typescript
import { requireSystemAccess } from "@/lib/api-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId } = await params;

  // Checks: user auth, system exists, user has read access
  const authResult = await requireSystemAccess(request, parseInt(systemId));
  if (authResult instanceof NextResponse) return authResult;

  const { system, isOwner, canWrite } = authResult;

  // Use system data...
}
```

For write operations, specify `requireWrite`:

```typescript
const authResult = await requireSystemAccess(request, systemId, {
  requireWrite: true,
});
```

### Access Levels

`requireSystemAccess` checks these access levels:

| Level      | canRead | canWrite | Description                                            |
| ---------- | ------- | -------- | ------------------------------------------------------ |
| Admin      | ✅      | ✅       | Platform admin                                         |
| Owner      | ✅      | ✅       | System owner (`ownerClerkUserId`)                      |
| Public     | ✅      | ❌       | Ownerless system (`ownerClerkUserId IS NULL`)          |
| Claude dev | ✅      | ❌       | `x-claude` header, development only                    |

Exactly: `canRead = isAdmin || isClaudeDev || isOwner || isPublic` and `canWrite = isAdmin || isOwner`.

There is no **Viewer** level. It was a fourth read term probing `user_systems`, removed with that table
in migration 0045 — it held 0 rows on prod and never conveyed write, so `canWrite` was unaffected and
`canRead` only narrowed. A dashboard grantee still gets in, via `requireDashboardAccess`.

## Cron Job Protection

Cron endpoints use `requireCronOrAdmin` for authentication:

```typescript
// app/api/cron/minutely/route.ts
import { requireCronOrAdmin } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const authResult = await requireCronOrAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  const sessionCause = authResult.isCron ? "CRON" : "ADMIN";

  // Execute cron job...
}
```

**Vercel Cron Configuration:**

```json
// vercel.json
{
  "crons": [
    { "path": "/api/cron/minutely", "schedule": "* * * * *" },
    { "path": "/api/cron/daily", "schedule": "5 0 * * *" }
  ]
}
```

### Vendor Credentials Security

**Storage:** Credentials are stored in Clerk's private metadata, which:

- Is never exposed to the frontend
- Is encrypted at rest by Clerk
- Requires server-side API calls to access
- Is isolated per user (no cross-user access)

**Access Pattern:**

```typescript
import { clerkClient } from "@clerk/nextjs/server";

// Only access credentials server-side
async function getVendorCredentials(userId: string, vendor: string) {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);

  // Private metadata is only accessible server-side
  const credentials = user.privateMetadata?.[vendor];

  if (!credentials) {
    throw new Error(`No credentials found for ${vendor}`);
  }

  return credentials;
}
```

## Performance Optimization

### Edge Runtime Compatibility

All auth middleware runs on Vercel Edge Runtime for instant auth checks globally.

### Avoid Multiple auth() Calls

```typescript
// ❌ Bad: Multiple auth() calls
export async function handler() {
  const { userId } = await auth();
  if (!userId) return unauthorized();

  const isAdmin = await isUserAdmin(); // Calls auth() again!
}

// ✅ Good: Single auth() call, pass data
export async function handler() {
  const { userId, sessionClaims } = await auth();
  if (!userId) return unauthorized();

  const isAdmin = sessionClaims?.isPlatformAdmin === true;
}
```

## Admin Access

### Environment-Based Admin List

```typescript
// lib/auth-utils.ts
import { auth, clerkClient } from "@clerk/nextjs/server";

export async function isUserAdmin(): Promise<boolean> {
  const { userId, sessionClaims } = await auth();

  if (!userId) return false;

  // Check session claims first (instant)
  if (sessionClaims?.isPlatformAdmin === true) {
    return true;
  }

  // Fallback: Check environment variable
  const adminUserIds = process.env.ADMIN_USER_IDS?.split(",") || [];
  if (adminUserIds.includes(userId)) {
    return true;
  }

  // Fallback: Check Clerk metadata
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return user.publicMetadata?.isPlatformAdmin === true;
}
```

### Admin Routes

```typescript
// app/admin/page.tsx
import { redirect } from 'next/navigation';
import { isUserAdmin } from '@/lib/auth-utils';

export default async function AdminPage() {
  const isAdmin = await isUserAdmin();

  if (!isAdmin) {
    redirect('/dashboard');
  }

  return <AdminDashboard />;
}
```

### Future Enhancements

- [ ] User impersonation for support
- [ ] Audit logging for auth events
- [ ] API key system for external access
- [ ] Webhook handling for user events
