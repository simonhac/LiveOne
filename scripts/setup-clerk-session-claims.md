# Setup Clerk Session Claims for Performance

## Why This Is Important
Currently, checking admin status makes a network call to Clerk's API (~100-150ms).
By adding the admin status to the session token, we eliminate this network call entirely.

## Steps to Configure in Clerk Dashboard

1. **Sign in to Clerk Dashboard**
   - Go to https://dashboard.clerk.com
   - Select your application

2. **Navigate to Sessions**
   - In the left sidebar, click on "Sessions"
   - Click on "Edit" under "Customize session token"

3. **Add Custom Claims**
   Add the following JSON to the claims editor:

   ```json
   {
     "isPlatformAdmin": "{{user.private_metadata.isPlatformAdmin}}"
   }
   ```

4. **Save Changes**
   - Click "Save" button
   - Changes take effect immediately for new sessions
   - Existing sessions will get the new claims on next refresh (within 60 seconds)

## Verify It's Working

After configuration, test in your app:

```typescript
// In any API route or server component
import { auth } from '@clerk/nextjs/server'

const { sessionClaims } = await auth()
console.log('Has admin claim:', 'isPlatformAdmin' in (sessionClaims || {}))
console.log('Is admin:', sessionClaims?.isPlatformAdmin === true)
```

## Benefits
- **Before**: ~100-150ms network call per admin check
- **After**: 0ms (data is in the JWT token)
- Works perfectly with Edge Runtime
- No additional API rate limit concerns

## Note on Token Size
Clerk cookies are limited to 4KB total. After default claims, you have ~1.2KB for custom claims.
The `isPlatformAdmin` boolean uses minimal space, so this is safe.