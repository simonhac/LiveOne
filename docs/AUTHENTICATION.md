# LiveOne Authentication & Security

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

# Database
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token

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

Systems are linked to Clerk users via the `systems` table:

```typescript
// lib/db/schema.ts
export const systems = sqliteTable("systems", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerClerkUserId: text("owner_clerk_user_id"), // Clerk user ID
  vendorType: text("vendor_type").notNull(), // 'selectronic', 'enphase', etc.
  displayName: text("display_name").notNull(),
  // ... other fields
});

export const userSystems = sqliteTable("user_systems", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clerkUserId: text("clerk_user_id").notNull(), // Viewer access
  systemId: integer("system_id").notNull(),
  role: text("role").notNull().default("viewer"), // 'owner', 'viewer'
});
```

### Access Control

```typescript
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { systems, userSystems } from "@/lib/db/schema";
import { eq, or } from "drizzle-orm";

// Get systems user has access to
export async function getUserSystems(userId: string) {
  const ownedSystems = await db
    .select()
    .from(systems)
    .where(eq(systems.ownerClerkUserId, userId));

  const sharedSystems = await db
    .select({ system: systems })
    .from(userSystems)
    .innerJoin(systems, eq(userSystems.systemId, systems.id))
    .where(eq(userSystems.clerkUserId, userId));

  return [...ownedSystems, ...sharedSystems.map((s) => s.system)];
}

// Check if user can access system
export async function canAccessSystem(userId: string, systemId: number) {
  const system = await db
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);

  if (!system.length) return false;

  // Owner check
  if (system[0].ownerClerkUserId === userId) return true;

  // Shared access check
  const access = await db
    .select()
    .from(userSystems)
    .where(eq(userSystems.systemId, systemId))
    .where(eq(userSystems.clerkUserId, userId))
    .limit(1);

  return access.length > 0;
}
```

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

### Cron Job Protection

```typescript
// app/api/cron/minutely/route.ts
import { headers } from "next/headers";
import { isUserAdmin } from "@/lib/auth-utils";

export async function POST(request: Request) {
  const headersList = await headers();
  const authHeader = headersList.get("authorization");

  // Check Bearer token OR admin user
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token !== process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    // Allow admin users to trigger manually
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Execute cron job...
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

## Implementation Checklist

### ✅ Completed

- [x] Clerk account and application setup
- [x] Install @clerk/nextjs package
- [x] ClerkProvider in app layout
- [x] Environment variables configured
- [x] Authentication middleware with Edge Runtime
- [x] Sign-in and sign-up pages
- [x] Redirect URLs configured
- [x] User metadata schema (public vs private)
- [x] Session claims for isPlatformAdmin
- [x] Role-based access via session claims
- [x] Vendor credentials in private metadata
- [x] System ownership model
- [x] Multi-user access control

### Future Enhancements

- [ ] Social login providers (Google, GitHub)
- [ ] User impersonation for support
- [ ] Audit logging for auth events
- [ ] API key system for external access
- [ ] Webhook handling for user events
