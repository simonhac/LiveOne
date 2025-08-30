# Authentication Architecture

## Overview

LiveOne uses a dual-authentication system:
1. **Clerk** - User authentication and session management for the web application
2. **Select.Live Credentials** - Per-user API credentials for fetching inverter data

## Architecture Diagram

```
┌─────────────────┐
│     Browser     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────────┐
│   Next.js App   │◄────►│  Clerk Service   │
│                 │      │                  │
│  - Public Pages │      │ - User Auth      │
│  - Dashboard    │      │ - Sessions       │
│  - Admin Panel  │      │ - User Metadata  │
└────────┬────────┘      └──────────────────┘
         │
         ▼
┌─────────────────┐
│   API Routes    │
│                 │
│ - /api/data     │
│ - /api/admin/*  │
│ - /api/cron/*   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────────┐
│    Database     │      │  Select.Live API │
│                 │      │                  │
│ - Systems       │◄────►│ - Inverter Data  │
│ - Readings      │      │ - Per-User Auth  │
│ - Aggregations  │      │                  │
└─────────────────┘      └──────────────────┘
```

## 1. User Authentication (Clerk)

### Setup
- **Provider**: Clerk (clerk.com)
- **Integration**: @clerk/nextjs
- **Session Management**: Cookie-based with JWT

### Configuration

#### Environment Variables (.env.local)
```bash
# Clerk API Keys
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Clerk URLs
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/
```

### Middleware Configuration

The middleware (`middleware.ts`) protects routes using Clerk:

```typescript
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/cron(.*)', // Cron endpoints have their own authentication
])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
  }
})
```

### Protected Routes
- `/dashboard` - User dashboard (requires authentication)
- `/admin/*` - Admin panel (requires authentication + admin role)
- `/api/admin/*` - Admin API endpoints
- `/api/history` - Historical data API

### Public Routes
- `/` - Landing page
- `/sign-in`, `/sign-up` - Authentication pages
- `/api/data` - Public data endpoint (read-only)
- `/api/cron/*` - Cron endpoints (protected by CRON_SECRET)

## 2. Select.Live Credentials Management

### Storage Architecture

Select.Live credentials are stored in Clerk's private metadata for each user:

```typescript
// Stored in Clerk User Private Metadata
{
  selectLiveCredentials: {
    email: string,      // Select.Live email
    password: string,   // Select.Live password (encrypted)
    did: number,        // Device ID (system number)
    lastUpdated: string // ISO timestamp
  }
}
```

### Credential Access

Credentials are accessed via helper functions in `/lib/secure-credentials.ts`:

```typescript
// Get credentials for a user
const credentials = await getSelectLiveCredentials(clerkUserId)

// Set/update credentials for a user
await setSelectLiveCredentials(clerkUserId, {
  email: 'user@example.com',
  password: 'encrypted_password',
  did: 1586
})
```

### Security Considerations

1. **Encryption**: Passwords are encrypted before storage in Clerk
2. **Access Control**: Only the user and admins can access credentials
3. **Audit Trail**: All credential updates are logged with timestamps
4. **No Hardcoding**: Credentials are never stored in code or config files

## 3. Multi-User System Architecture

### System Ownership

Each inverter system has an owner defined in the database:

```sql
-- systems table
CREATE TABLE systems (
  id INTEGER PRIMARY KEY,
  user_id TEXT,              -- Legacy username
  owner_clerk_user_id TEXT,  -- Clerk user ID (authoritative)
  system_number TEXT,        -- Select.Live device ID
  display_name TEXT,
  -- ... other fields
)
```

### Data Access Rules

1. **Regular Users**:
   - Can only view their own system(s)
   - Can test connection for their own system
   - Dashboard shows only their data

2. **Admin Users**:
   - Can view all systems
   - Can test any system's connection
   - Access to admin panel at `/admin`
   - Can manage user credentials

### Admin Detection

Admin status is determined by the `isUserAdmin()` function:

```typescript
// lib/auth-utils.ts
export async function isUserAdmin(): Promise<boolean> {
  const { userId } = await auth()
  if (!userId) return false
  
  // Check if user ID matches admin list
  return ADMIN_USER_IDS.includes(userId)
}
```

## 4. API Authentication

### Public Endpoints

#### GET /api/data
- No authentication required
- Returns aggregated system data
- Read-only access

### Protected Endpoints

#### GET /api/admin/systems
- Requires: Clerk authentication
- Admin only: Returns all systems with status

#### POST /api/admin/test-connection
- Requires: Clerk authentication
- Validates: User owns the system OR is admin
- Returns: Live data from Select.Live

#### GET /api/history
- Requires: Clerk authentication OR Bearer token
- Returns: Historical time-series data

### Cron Endpoints

#### GET /api/cron/minutely
- Development: No authentication
- Production: Requires `Authorization: Bearer ${CRON_SECRET}`
- Polls all systems using their owner's credentials

#### GET /api/cron/daily
- Development: No authentication  
- Production: Requires `Authorization: Bearer ${CRON_SECRET}`
- Runs daily aggregation

## 5. Data Polling Architecture

### Per-User Polling

The cron job (`/api/cron/minutely`) polls each system using the owner's credentials:

```typescript
// For each system in database:
1. Get system's owner_clerk_user_id
2. Fetch owner's Select.Live credentials from Clerk
3. Create SelectronicFetchClient with user's credentials
4. Authenticate with Select.Live
5. Fetch and store data
```

### Polling Status Tracking

```sql
-- polling_status table tracks health per system
CREATE TABLE polling_status (
  system_id INTEGER,
  last_poll_time TIMESTAMP,
  last_success_time TIMESTAMP,
  last_error TEXT,
  consecutive_errors INTEGER,
  is_active BOOLEAN
)
```

## 6. Security Best Practices

### Do's ✅
- Store credentials in Clerk private metadata
- Use environment variables for API keys
- Validate system ownership before data access
- Log all credential updates
- Use HTTPS in production
- Rotate API keys regularly

### Don'ts ❌
- Never commit credentials to git
- Don't store passwords in plain text
- Don't share credentials between users
- Don't expose Clerk secret key
- Don't disable authentication in production

## 7. Setup Guide for New Users

### Step 1: Create Clerk Account
1. User signs up at `/sign-up`
2. Clerk creates user account
3. User is redirected to dashboard

### Step 2: Add Select.Live Credentials
1. Admin accesses Clerk dashboard
2. Locates user by email
3. Adds private metadata:
```json
{
  "selectLiveCredentials": {
    "email": "user@selectronic.com",
    "password": "encrypted_password",
    "did": 648,
    "lastUpdated": "2025-08-29T10:00:00Z"
  }
}
```

### Step 3: Register System in Database
```sql
INSERT INTO systems (
  user_id, 
  owner_clerk_user_id,
  system_number,
  display_name
) VALUES (
  'username',
  'user_clerk_id',
  '648',
  'User Solar System'
);
```

### Step 4: Verify Setup
1. Admin uses "Test" button in admin panel
2. Confirms data is being retrieved
3. Monitoring begins automatically via cron

## 8. Troubleshooting

### Common Issues

#### "No Select.Live credentials found"
- Check Clerk dashboard for user's private metadata
- Verify credentials format is correct
- Ensure `did` matches system number

#### "Authentication failed" 
- Verify Select.Live credentials are correct
- Check if password needs to be updated
- Ensure email format matches Select.Live requirements

#### "Access denied to this system"
- Verify user's Clerk ID matches system's owner_clerk_user_id
- Check if user has admin privileges if accessing other's systems

#### Polling not working
- Check cron job logs in Vercel dashboard
- Verify CRON_SECRET is set in production
- Ensure each system has valid owner credentials

## 9. Environment Variables Reference

### Required in Production

```bash
# Clerk (Authentication)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...

# Database
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...

# Cron Jobs
CRON_SECRET=random_secure_string

# Admin Users
ADMIN_USER_IDS=user_id1,user_id2
```

### Optional

```bash
# Development Only
NODE_ENV=development

# Custom URLs (if different from defaults)
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/custom-sign-in
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/custom-dashboard
```

## 10. Migration Notes

### From Single-User to Multi-User

The system has been migrated from a single-user setup to multi-user:

1. **Old**: Hardcoded credentials in USER_SECRETS.ts
2. **New**: Per-user credentials in Clerk metadata

3. **Old**: Single system polling with env variables
4. **New**: Multi-system polling with per-user credentials

5. **Old**: No user authentication
6. **New**: Full user management with Clerk

### Breaking Changes

- USER_SECRETS.ts no longer contains Select.Live credentials
- Cron endpoints now require each system to have owner_clerk_user_id
- API endpoints now check user authentication via Clerk
- Admin panel requires explicit admin user IDs in environment

---

*Last Updated: August 2025*
*Version: 2.0 - Multi-User Architecture*