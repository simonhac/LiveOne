# LiveOne Authentication & Security Architecture

## Authentication Strategy

### Core Technology: Clerk

We'll use Clerk for authentication, providing a complete auth solution with beautiful UI components, user management, and built-in security features.

```typescript
// app/layout.tsx
import { ClerkProvider } from '@clerk/nextjs'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
```

```typescript
// middleware.ts
import { authMiddleware } from "@clerk/nextjs";

export default authMiddleware({
  publicRoutes: ["/", "/api/webhooks/clerk"],
  ignoredRoutes: ["/api/cron/poll-devices"],
});

export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"]
};
```

```typescript
// app/sign-in/[[...sign-in]]/page.tsx
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return <SignIn />;
}
```

```typescript
// app/sign-up/[[...sign-up]]/page.tsx
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return <SignUp />;
}
```

### User Metadata & Device Management

```typescript
// Store device ownership in Clerk user metadata
import { currentUser } from '@clerk/nextjs';

// Get current user with metadata
const user = await currentUser();
const deviceLimit = user?.publicMetadata?.deviceLimit || 5;
const subscription = user?.privateMetadata?.subscription || 'free';

// Update user metadata (admin only)
import { clerkClient } from '@clerk/nextjs';

await clerkClient.users.updateUserMetadata(userId, {
  publicMetadata: {
    deviceLimit: 10,
    role: 'premium'
  },
  privateMetadata: {
    subscription: 'pro',
    stripeCustomerId: 'cus_xxx'
  }
});
```

## Secrets Management Architecture

### 1. Environment Variables (Development & Production)

```bash
# .env.local (development)
# .env.production (Vercel)

# Core Secrets
NEXTAUTH_SECRET=           # 32+ char random string for session encryption
NEXTAUTH_URL=              # https://liveone.app

# Database
POSTGRES_PRISMA_URL=       # Connection with pooling
POSTGRES_URL_NON_POOLING=  # Direct connection

# Encryption Keys
ENCRYPTION_KEY=            # AES-256 key for device credentials
ENCRYPTION_IV=             # Initialization vector

# MQTT
MQTT_BROKER_URL=           # mqtts://broker.hivemq.cloud:8883
MQTT_USERNAME=             # Service account username
MQTT_PASSWORD=             # Service account password

# Email (optional)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASSWORD=
```

### 2. Device Credentials Encryption

```typescript
// lib/crypto.ts
import crypto from 'crypto'

const algorithm = 'aes-256-gcm'
const key = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex')

export function encryptCredentials(credentials: object): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(algorithm, key, iv)
  
  const text = JSON.stringify(credentials)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  
  const authTag = cipher.getAuthTag()
  
  return JSON.stringify({
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    encrypted
  })
}

export function decryptCredentials(encryptedData: string): object {
  const { iv, authTag, encrypted } = JSON.parse(encryptedData)
  
  const decipher = crypto.createDecipheriv(
    algorithm, 
    key, 
    Buffer.from(iv, 'hex')
  )
  decipher.setAuthTag(Buffer.from(authTag, 'hex'))
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  
  return JSON.parse(decrypted)
}
```

### 3. API Key Management

```typescript
// For MQTT/API access outside the web app
interface ApiKey {
  id: string
  userId: string
  name: string
  keyHash: string  // Hashed version
  prefix: string   // First 8 chars for identification
  scopes: string[] // Permissions
  lastUsed: Date
  expiresAt: Date
}

// Generate API key
function generateApiKey(): { key: string, hash: string, prefix: string } {
  const key = `liveone_${crypto.randomBytes(32).toString('base64url')}`
  const hash = crypto.createHash('sha256').update(key).digest('hex')
  const prefix = key.substring(0, 15) // liveone_xxx...
  
  return { key, hash, prefix }
}
```

### 4. Session Security with Clerk

```typescript
// Using Clerk's built-in session management
import { auth } from '@clerk/nextjs';

export async function GET(request: Request) {
  const { userId, sessionClaims } = auth();
  
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  // Check custom claims
  const role = sessionClaims?.metadata?.role;
  if (role !== 'admin') {
    return new Response('Forbidden', { status: 403 });
  }
  
  // Process request...
}

// Client-side hooks
import { useAuth, useUser } from '@clerk/nextjs';

function Dashboard() {
  const { isLoaded, userId, sessionId } = useAuth();
  const { user } = useUser();
  
  if (!isLoaded || !userId) {
    return <div>Loading...</div>;
  }
  
  return <div>Welcome {user?.firstName}!</div>;
}
```

## Why We're Using Clerk

### ✅ Advantages of Clerk

1. **Rapid Development**
   - 2-hour setup vs 1-2 weeks
   - Pre-built UI components
   - User management dashboard included
   - Zero auth code to maintain

2. **Free Tier**
   - Up to 10,000 monthly active users free
   - Perfect for starting with <5 users
   - All features included (unlike Auth0)
   - No credit card required

3. **Beautiful UI Out-of-Box**
   - Professional sign-in/sign-up components
   - Customizable to match brand
   - Multi-factor auth UI included
   - User profile management built-in

4. **Security Handled**
   - SOC 2 Type II certified
   - Automatic security updates
   - Bot protection included
   - Session management handled

5. **Developer Experience**
   - Excellent documentation
   - TypeScript support
   - React hooks for easy integration
   - Webhooks for user events

6. **Built-in Features**
   - Social logins (Google, GitHub, etc.)
   - Magic links
   - Multi-factor authentication
   - Device management
   - User impersonation for support

### ⚠️ Trade-offs with Clerk

1. **Costs at Scale**
   - Free up to 10,000 MAU
   - $25/month for 10,001-25,000 MAU
   - Can get expensive with growth

2. **Vendor Lock-in**
   - User data in Clerk's database
   - Migration requires user password resets
   - Custom auth flows limited

3. **Less Control**
   - Can't modify auth logic directly
   - Limited custom session logic
   - Dependent on Clerk's uptime

## Security Best Practices

### Clerk Security Configuration
```typescript
// Configure in Clerk Dashboard
// Dashboard -> User & Authentication -> Email, Phone, Username

// Password requirements (set in Clerk Dashboard):
- Minimum 8 characters
- Require uppercase letter
- Require lowercase letter  
- Require number
- Require special character
- Enable leak detection

// Session settings:
- Session timeout: 7 days
- Inactivity timeout: 30 minutes
- Multi-session: Enabled
```

### Rate Limiting
```typescript
// lib/rate-limit.ts
import { LRUCache } from 'lru-cache'

const tokenCache = new LRUCache<string, number>({
  max: 500,
  ttl: 1000 * 60 * 15, // 15 minutes
})

export async function rateLimit(request: Request) {
  const ip = request.headers.get('x-forwarded-for') ?? 'anonymous'
  const tokenCount = tokenCache.get(ip) ?? 0
  
  if (tokenCount > 10) {
    throw new Error('Rate limit exceeded')
  }
  
  tokenCache.set(ip, tokenCount + 1)
}
```

### Audit Logging
```typescript
// Log all authentication events
interface AuditLog {
  userId?: string
  action: 'login' | 'logout' | 'register' | 'password_reset' | 'device_access'
  ipAddress: string
  userAgent: string
  success: boolean
  metadata?: object
  timestamp: Date
}

async function logAuditEvent(event: AuditLog) {
  await prisma.auditLog.create({ data: event })
}
```

## Implementation Checklist with Clerk

### Phase 1: Clerk Setup (Day 1)
- [ ] Create Clerk account and application
- [ ] Install @clerk/nextjs package
- [ ] Add ClerkProvider to app layout
- [ ] Configure environment variables
- [ ] Set up authentication middleware
- [ ] Add sign-in and sign-up pages
- [ ] Configure redirect URLs

### Phase 2: User Management (Day 1-2)
- [ ] Set up user metadata schema
- [ ] Configure custom claims for device limits
- [ ] Create user profile page
- [ ] Implement role-based access (via metadata)
- [ ] Set up Clerk webhooks for user events

### Phase 3: Device Credentials (Day 2-3)
- [ ] Implement device credential encryption (still needed)
- [ ] Create secure storage in database
- [ ] Build API for device management
- [ ] Link devices to Clerk user IDs
- [ ] Add device ownership validation

### Phase 4: Integration (Day 3-4)
- [ ] Create API key system for MQTT
- [ ] Implement audit logging
- [ ] Set up user impersonation for support
- [ ] Configure social login providers
- [ ] Enable MFA for users

## Clerk Integration with LiveOne

### Environment Variables
```bash
# .env.local
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx

# Redirect URLs
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard/welcome

# Webhooks
CLERK_WEBHOOK_SECRET=whsec_xxx
```

### Storing Device Data with Clerk Users

```typescript
// Link devices to Clerk users in our database
interface Device {
  id: string;
  clerkUserId: string;  // From Clerk auth
  name: string;
  serialNumber: string;
  encryptedCredentials: string;
  settings: JsonValue;
  lastSeen: Date;
}

// API route to get user's devices
import { auth } from '@clerk/nextjs';

export async function GET() {
  const { userId } = auth();
  
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const devices = await prisma.device.findMany({
    where: { clerkUserId: userId }
  });
  
  return Response.json(devices);
}
```

### Migration Strategy

When ready to scale beyond Clerk's free tier:

1. **Export user data** via Clerk API
2. **Set up NextAuth.js** with same user IDs
3. **Migrate user sessions** gradually
4. **Keep device data** in your database (no migration needed)

The key is keeping device ownership in YOUR database, linked by Clerk user ID. This makes future migration much easier.