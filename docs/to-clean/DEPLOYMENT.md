# Deployment Guide

## Pre-Deployment Checklist

### 1. Database Schema Verification

**CRITICAL**: Before deploying schema changes, verify ALL tables exist in production:

```bash
# Compare dev and production schemas
sqlite3 dev.db ".schema" > dev-schema.sql
~/.turso/turso db shell liveone-tokyo ".schema" > prod-schema.sql
diff dev-schema.sql prod-schema.sql
```

### 2. Migration Scripts

For every schema change, create TWO scripts:

- `migrate-{feature}.sql` - Forward migration
- `rollback-{feature}.sql` - Rollback script

Include in migration scripts:

- [ ] Schema changes (CREATE TABLE, ALTER TABLE)
- [ ] Data migrations (INSERT, UPDATE)
- [ ] Index creation
- [ ] User permissions/relationships
- [ ] Verification queries

### 3. Test Migration on Backup

```bash
# Create fresh backup
~/.turso/turso db shell liveone-tokyo ".dump" > backup-$(date +%Y%m%d-%H%M%S).sql

# Test locally
sqlite3 test.db < backup.sql
sqlite3 test.db < scripts/migrate-{feature}.sql
# Verify all tables and data
sqlite3 test.db "SELECT name FROM sqlite_master WHERE type='table'"
```

### 4. Environment Variables

Verify all required environment variables are set in Vercel:

```bash
vercel env ls production
```

Required variables:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_WEBHOOK_SECRET`
- `ADMIN_PASSWORD`
- `CRON_SECRET`

## Deployment Process

### Step 1: Pre-flight Checks

```bash
# 1. Run type checking
npm run type-check

# 2. Build locally
npm run build

# 3. List all production tables
~/.turso/turso db shell liveone-tokyo "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# 4. Verify user data
~/.turso/turso db shell liveone-tokyo "SELECT * FROM user_systems"
```

### Step 2: Deploy Code

```bash
# Deploy to Vercel
git push origin main

# Monitor deployment
vercel ls
vercel logs <deployment-url>
```

### Step 3: Run Migrations

```bash
# Execute migrations in order
~/.turso/turso db shell liveone-tokyo < scripts/migrate-1-{feature}.sql
~/.turso/turso db shell liveone-tokyo < scripts/migrate-2-{feature}.sql

# Verify migrations
~/.turso/turso db shell liveone-tokyo "SELECT * FROM {affected_tables}"
```

### Step 4: Post-Deployment Verification

```bash
# Check health status first
curl https://liveone.vercel.app/api/health | jq '.'

# Verify all checks are passing
curl -s https://liveone.vercel.app/api/health | jq '.status'
# Should return: "healthy"

# Test API endpoints
curl https://liveone.vercel.app/api/data
curl https://liveone.vercel.app/api/systems

# Check application pages
curl -I https://liveone.vercel.app/dashboard
```

## Rollback Procedure

If issues occur:

```bash
# 1. Rollback database
~/.turso/turso db shell liveone-tokyo < scripts/rollback-{feature}.sql

# 2. Revert code
git revert HEAD --no-edit
git push origin main

# 3. Verify rollback
~/.turso/turso db shell liveone-tokyo "SELECT * FROM systems"
```

## Common Issues

### Missing Tables in Production

**Symptom**: `SQLite error: no such table: {table_name}`
**Solution**:

1. Check if table exists: `~/.turso/turso db shell liveone-tokyo ".tables"`
2. Run missing migration scripts
3. Verify foreign key relationships

### Incorrect User IDs

**Symptom**: Authentication failures, 404 errors
**Solution**:

1. Verify Clerk user IDs match between dev and prod
2. Update user_systems and systems tables with correct IDs
3. Never hardcode user IDs in migration scripts - use environment variables or config

### Schema Mismatch

**Symptom**: Type errors, missing columns
**Solution**:

1. Compare schemas between dev and prod
2. Create incremental migration scripts
3. Test on backup before applying to production

## Migration Script Template

```sql
-- Migration: {description}
-- Date: {date}
-- Author: {author}

BEGIN TRANSACTION;

-- Step 1: Schema changes
CREATE TABLE IF NOT EXISTS ...

-- Step 2: Data migration
INSERT INTO ...

-- Step 3: Verify migration
SELECT 'Migration complete' as status,
       COUNT(*) as affected_rows
FROM {table};

COMMIT;
```

## Lessons Learned

1. **Always diff schemas** before deployment
2. **Test complete migration path** including all dependent tables
3. **Use actual production data** in migration scripts (not placeholders)
4. **Create comprehensive rollback scripts** before starting migration
5. **Document all manual steps** that need to be performed
6. **Verify deployment incrementally** - don't assume success
