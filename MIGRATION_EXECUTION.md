# Production Migration Execution Plan
## Estimated downtime: < 2 minutes

### ✅ Pre-flight Checklist
- [x] Production backup created: `backup-20250830-112724.db`
- [x] Migration script tested: `scripts/migrate-prod-vendor-timezone.sql`
- [x] Rollback script tested: `scripts/rollback-vendor-timezone.sql`
- [x] Local testing successful on backup database
- [ ] Verify Clerk user ID is correct: `user_2lr5J4UZ7x3I37tEOQmPRhWzpnf`

### 🚀 Execution Commands

#### Step 1: Deploy Code (30 seconds)
```bash
# Push to main branch - Vercel auto-deploys
git push origin main
```

#### Step 2: Run Migration (30 seconds)
```bash
# Execute migration on production database
~/.turso/turso db shell liveone-tokyo < scripts/migrate-prod-vendor-timezone.sql
```

#### Step 3: Verify Migration (20 seconds)
```bash
# Check that migration succeeded
~/.turso/turso db shell liveone-tokyo "SELECT vendor_type, vendor_site_id, timezone_offset_min FROM systems"

# Expected output:
# select.live|1586|600
```

#### Step 4: Test Application (20 seconds)
```bash
# Test the API endpoint
curl https://liveone.vercel.app/api/data \
  -H "Cookie: auth-token=${AUTH_PASSWORD}"

# Test polling
curl https://liveone.vercel.app/api/cron/minutely \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

### 🔴 If Rollback Needed (< 1 minute)

```bash
# Step 1: Rollback database
~/.turso/turso db shell liveone-tokyo < scripts/rollback-vendor-timezone.sql

# Step 2: Revert code
git revert HEAD --no-edit
git push origin main

# Step 3: Verify rollback
~/.turso/turso db shell liveone-tokyo "SELECT user_id, system_number FROM systems"
```

### 📊 Post-Migration Verification

1. **Check Dashboard**
   - Visit https://liveone.vercel.app/dashboard
   - Verify data is displaying correctly

2. **Monitor Polling**
   - Check Vercel logs for successful polling
   - Verify new readings are being saved

3. **Check Aggregations**
   - Verify 5-minute aggregations continue
   - Verify daily aggregations work at midnight

### ⚠️ Important Notes

1. **Clerk User ID**: The migration maps `simon` → `user_2lr5J4UZ7x3I37tEOQmPRhWzpnf`
   - Verify this is your actual Clerk user ID before running

2. **Backward Compatibility**: The new code can handle both schemas during migration

3. **Atomic Transaction**: The entire migration runs in a transaction - it either fully succeeds or fully fails

4. **Quick Recovery**: Keep the rollback script ready in another terminal

### 📞 Support Contacts
- Keep Vercel dashboard open for monitoring
- Have Turso dashboard ready for database monitoring
- Migration scripts are idempotent - safe to re-run if needed

### Timeline
- **11:30** - Final code review
- **11:35** - Push code to main
- **11:36** - Run database migration
- **11:37** - Verify and test
- **11:38** - Migration complete

Total time: **< 2 minutes of actual downtime**