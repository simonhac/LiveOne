# Production Migration Strategy - Vendor Type/Site ID Refactor
## Target: < 2 minutes downtime

### Overview
Migration from `system_number` to `vendor_type`/`vendor_site_id` with timezone changes from hours to minutes.

### Pre-Migration Checklist
- [x] Backup production database (backup-20250830-112724.db)
- [ ] Test migration on backup locally
- [ ] Prepare rollback script
- [ ] Verify Vercel environment variables
- [ ] Prepare deployment command

### Migration Steps

#### Step 1: Prepare Migration Script (0 downtime)
Create a single SQL script that runs all changes atomically:

```sql
-- migrate-prod.sql
BEGIN TRANSACTION;

-- Add new columns to systems table
ALTER TABLE systems ADD COLUMN vendor_type TEXT;
ALTER TABLE systems ADD COLUMN vendor_site_id TEXT;
ALTER TABLE systems ADD COLUMN timezone_offset_min INTEGER;

-- Populate new columns with data
UPDATE systems 
SET 
  vendor_type = 'select.live',
  vendor_site_id = system_number,
  timezone_offset_min = timezone_offset * 60,
  display_name = COALESCE(display_name, 'System ' || system_number);

-- Make new columns NOT NULL after populating
-- Note: SQLite doesn't support ALTER COLUMN, so we need to recreate the table
CREATE TABLE systems_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_clerk_user_id TEXT,
  vendor_type TEXT NOT NULL,
  vendor_site_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  model TEXT,
  serial TEXT,
  ratings TEXT,
  solar_size TEXT,
  battery_size TEXT,
  timezone_offset_min INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copy data to new table
INSERT INTO systems_new (
  id, owner_clerk_user_id, vendor_type, vendor_site_id, display_name,
  model, serial, ratings, solar_size, battery_size, timezone_offset_min,
  created_at, updated_at
)
SELECT 
  id, owner_clerk_user_id, vendor_type, vendor_site_id, display_name,
  model, serial, ratings, solar_size, battery_size, timezone_offset_min,
  created_at, updated_at
FROM systems;

-- Drop old table and rename new one
DROP TABLE systems;
ALTER TABLE systems_new RENAME TO systems;

-- Recreate indexes
CREATE INDEX idx_systems_vendor ON systems(vendor_type, vendor_site_id);
CREATE INDEX idx_systems_owner ON systems(owner_clerk_user_id);

COMMIT;
```

#### Step 2: Execution Plan (< 2 minutes)

1. **Deploy new code to Vercel (30 seconds)**
   ```bash
   git push origin main
   ```
   - Vercel will automatically build and prepare deployment
   - New code is backward compatible during migration

2. **Run migration on Turso (30 seconds)**
   ```bash
   ~/.turso/turso db shell liveone-tokyo < migrate-prod.sql
   ```

3. **Verify migration (30 seconds)**
   ```bash
   ~/.turso/turso db shell liveone-tokyo "SELECT vendor_type, vendor_site_id, timezone_offset_min FROM systems LIMIT 1"
   ```

4. **Redeploy to activate (30 seconds)**
   - Vercel will automatically switch to new deployment
   - Polling will resume with new schema

### Rollback Plan (if needed)

```sql
-- rollback.sql
BEGIN TRANSACTION;

-- Recreate original structure
CREATE TABLE systems_rollback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  owner_clerk_user_id TEXT,
  system_number TEXT NOT NULL,
  display_name TEXT,
  model TEXT,
  serial TEXT,
  ratings TEXT,
  solar_size TEXT,
  battery_size TEXT,
  timezone_offset INTEGER DEFAULT 10,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copy data back
INSERT INTO systems_rollback (
  id, owner_clerk_user_id, system_number, display_name,
  model, serial, ratings, solar_size, battery_size, timezone_offset,
  created_at, updated_at
)
SELECT 
  id, owner_clerk_user_id, vendor_site_id, display_name,
  model, serial, ratings, solar_size, battery_size, timezone_offset_min / 60,
  created_at, updated_at
FROM systems;

DROP TABLE systems;
ALTER TABLE systems_rollback RENAME TO systems;

COMMIT;
```

### Testing on Backup

```bash
# Test migration locally on backup
cp backup-20250830-112724.db test-migration.db
sqlite3 test-migration.db < scripts/migrate-vendor-and-timezone.sql

# Verify
sqlite3 test-migration.db "SELECT * FROM systems"
sqlite3 test-migration.db ".schema systems"
```

### Key Points
1. **Backward Compatibility**: The new code can read both old and new schema during migration
2. **Atomic Transaction**: All changes happen in a single transaction - either all succeed or all fail
3. **Quick Rollback**: If issues arise, rollback script can restore original schema in < 1 minute
4. **Minimal Polling Interruption**: Only the actual migration time affects polling (< 30 seconds)

### Post-Migration Verification
```bash
# Check system is polling
curl https://liveone.vercel.app/api/data -H "Cookie: auth-token=YOUR_TOKEN"

# Check cron job
curl https://liveone.vercel.app/api/cron/minutely -H "Authorization: Bearer YOUR_CRON_SECRET"

# Monitor logs in Vercel dashboard
```

### Estimated Timeline
- Code deployment: 30 seconds
- Database migration: 30 seconds  
- Verification: 30 seconds
- Buffer time: 30 seconds
**Total: < 2 minutes**