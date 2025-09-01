# CLAUDE.md - Project Management Guide

## Turso Database Management

### Installing and Setting Up Turso CLI

```bash
# Install Turso CLI (persists in ~/.turso)
curl -sSfL https://get.tur.so/install.sh | bash
export PATH="$HOME/.turso:$PATH"  # Add to PATH
echo 'export PATH="$HOME/.turso:$PATH"' >> ~/.zshrc  # Make permanent

# Authenticate (one-time setup)
~/.turso/turso auth login

# List available databases
~/.turso/turso db list

# Connect to production database shell
~/.turso/turso db shell liveone-tokyo

# Or use direct connection with URL
~/.turso/turso db shell libsql://liveone-tokyo-simonhac.aws-ap-northeast-1.turso.io
```

### Quick Database Commands

```bash
# Check recent data
~/.turso/turso db shell liveone-tokyo "SELECT system_id, day, solar_kwh, load_kwh FROM readings_agg_1d ORDER BY day DESC LIMIT 5"

# Count records
~/.turso/turso db shell liveone-tokyo "SELECT COUNT(*) as count FROM readings_agg_5m"

# Check distinct systems
~/.turso/turso db shell liveone-tokyo "SELECT DISTINCT system_id FROM readings_agg_5m"

# Get fresh auth token
~/.turso/turso db tokens create liveone-tokyo
```

### Common SQL Operations

#### Check Latest Data
```sql
-- Get latest reading
SELECT datetime(inverter_time, 'unixepoch') as time, 
       solar_w, load_w, battery_w, battery_soc
FROM readings 
ORDER BY inverter_time DESC 
LIMIT 5;

-- Check 5-minute aggregated data
SELECT datetime(interval_end, 'unixepoch') as time,
       solar_w_avg, load_w_avg, battery_w_avg, battery_soc_last
FROM readings_agg_5m
ORDER BY interval_end DESC
LIMIT 10;

-- Count total readings
SELECT COUNT(*) as total_readings,
       datetime(MIN(inverter_time), 'unixepoch') as oldest,
       datetime(MAX(inverter_time), 'unixepoch') as newest
FROM readings;
```

#### Data Health Checks
```sql
-- Check for duplicate timestamps (should return 0)
SELECT inverter_time, COUNT(*) as count
FROM readings
WHERE system_id = 1586
GROUP BY inverter_time
HAVING COUNT(*) > 1;

-- Check for data gaps larger than 2 minutes
WITH time_diffs AS (
  SELECT 
    inverter_time,
    LAG(inverter_time) OVER (ORDER BY inverter_time) as prev_time,
    inverter_time - LAG(inverter_time) OVER (ORDER BY inverter_time) as diff
  FROM readings
  WHERE system_id = 1586
)
SELECT 
  datetime(prev_time, 'unixepoch') as gap_start,
  datetime(inverter_time, 'unixepoch') as gap_end,
  diff / 60 as gap_minutes
FROM time_diffs
WHERE diff > 120
ORDER BY inverter_time DESC
LIMIT 20;

-- Check aggregation status
SELECT 
  datetime(MAX(interval_end), 'unixepoch') as latest_agg,
  (strftime('%s', 'now') - MAX(interval_end)) / 60 as minutes_behind
FROM readings_agg_5m;
```

#### Performance Analysis
```sql
-- Analyze data distribution by hour
SELECT 
  strftime('%H', datetime(inverter_time, 'unixepoch')) as hour,
  COUNT(*) as count,
  AVG(solar_w) as avg_solar_w
FROM readings
WHERE inverter_time > strftime('%s', 'now', '-7 days')
GROUP BY hour
ORDER BY hour;

-- Check table sizes
SELECT 
  name as table_name,
  SUM(pgsize) as size_bytes,
  ROUND(SUM(pgsize) / 1024.0 / 1024.0, 2) as size_mb
FROM dbstat
WHERE name IN ('readings', 'readings_agg_5m')
GROUP BY name;
```

#### Data Cleanup
```sql
-- NOTE: No automatic retention policies are currently implemented
-- The following commands are for manual cleanup if needed

-- Example: Remove old raw readings (if you want to manually clean up)
-- DELETE FROM readings 
-- WHERE inverter_time < strftime('%s', 'now', '-30 days');

-- Vacuum to reclaim space after manual cleanup
VACUUM;

-- Analyze for query optimization
ANALYZE;
```

### Database Schema Management

#### View Current Schema
```sql
-- List all tables
SELECT name FROM sqlite_master WHERE type='table';

-- Get table schema
.schema readings
.schema readings_agg_5m

-- List all indexes
SELECT name, tbl_name FROM sqlite_master WHERE type='index';
```

#### Apply Schema Changes
```bash
# From project root, push schema changes
npm run db:push

# Or manually apply SQL files
turso db shell liveone-prod-tokyo < scripts/recreate-agg5m-table.sql
```

### Backup and Migration

#### Create Backup
```bash
# Export database to SQL file
turso db export liveone-prod-tokyo > backup-$(date +%Y%m%d).sql

# Download as SQLite file
turso db export liveone-prod-tokyo --type sqlite > backup-$(date +%Y%m%d).db
```

#### Restore from Backup
```bash
# Create new database
turso db create liveone-restored --location hnd

# Import from SQL backup
turso db shell liveone-restored < backup-20250817.sql
```

### Performance Monitoring

#### Check Query Performance
```sql
-- Enable query timing in Turso shell
.timer on

-- Run your query
SELECT COUNT(*) FROM readings WHERE inverter_time > strftime('%s', 'now', '-7 days');

-- Check index usage
EXPLAIN QUERY PLAN
SELECT * FROM readings_agg_5m 
WHERE system_id = 1586 
  AND interval_end BETWEEN strftime('%s', 'now', '-24 hours') AND strftime('%s', 'now');
```

### Troubleshooting Common Issues

#### 1. Slow Queries
- Check if indexes exist on commonly queried columns
- Use EXPLAIN QUERY PLAN to verify index usage
- Consider creating covering indexes for frequent queries

#### 2. Duplicate Data
```sql
-- Find and remove duplicates while keeping newest
DELETE FROM readings
WHERE rowid NOT IN (
  SELECT MAX(rowid)
  FROM readings
  GROUP BY system_id, inverter_time
);
```

#### 3. Missing Aggregated Data
```bash
# Manually trigger aggregation
node scripts/aggregate-5min.js

# Check cron job logs in Vercel dashboard
```

### Environment Variables

Required for database access:
```bash
TURSO_DATABASE_URL=libsql://liveone-tokyo-simonhac.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=<your-token>  # Generate with: ~/.turso/turso db tokens create liveone-tokyo
```

### Database Locations

- **Production**: Tokyo (aws-ap-northeast-1)
- **Database Name**: liveone-tokyo
- **Region**: Optimized for Australian users
- **Response Time**: ~200ms from Australia

## Vercel Deployment Management

### Checking Build Logs

**Note: Vercel CLI is installed and available**

```bash
# Use the provided script to get build logs
./scripts/vercel-build-log.sh

# Or manually check deployments
vercel ls  # List recent deployments
vercel inspect <deployment-url> --logs  # Get build logs for specific deployment

# Check deployment status
vercel inspect <deployment-url> | grep status
```

### Common Deployment Issues

1. **Build Failures**
   - Check TypeScript errors: `npm run type-check`
   - Test build locally: `npm run build`
   - View build logs: `./scripts/vercel-build-log.sh`

2. **Type Errors with Drizzle**
   - `select()` doesn't accept arguments in our version
   - Use `select()` then filter/deduplicate in JavaScript
   - Example: `[...new Set(results.map(r => r.systemId))]`

3. **Environment Variables**
   - Ensure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set in Vercel
   - Update tokens if getting 404 errors: `~/.turso/turso db tokens create liveone-tokyo`

### Useful Vercel Commands

```bash
# Deploy to production
vercel --prod

# Check logs of running deployment  
vercel logs <deployment-url>

# List all deployments
vercel ls

# Remove a deployment
vercel rm <deployment-url>

# Pull environment variables from Vercel
vercel env pull .env.local
```

### Database Schema

For complete database schema documentation, see @docs/SCHEMA.md

### API Documentation

For comprehensive API endpoint documentation, see @docs/API.md

Key tables:
1. **readings** - Raw minute-by-minute data
2. **readings_agg_5m** - 5-minute aggregated data  
3. **readings_agg_1d** - Daily aggregated data (timezone-aware as of v4)
4. **systems** - Registered inverter systems (includes timezone_offset)
5. **polling_status** - Health monitoring for data collection

Manual daily aggregation: 
```bash
curl -X POST https://liveone.vercel.app/api/cron/daily \
  -H "Cookie: auth-token=password" \
  -d '{"action": "catchup"}'  # or "clear" to wipe and regenerate
```

### Data Pipeline

1. **Collection**: Vercel cron job polls Select.Live every minute
2. **Storage**: Raw data saved to `readings` table
3. **5-Minute Aggregation**: Created in real-time as data arrives
4. **Daily Aggregation**: Runs at 00:05 daily via cron job
5. **API**: Fast queries use pre-aggregated data (< 1 second response)
6. **Cleanup**: No automatic cleanup (retention policies not implemented)

### Performance Tips

1. Always use indexes for time-based queries
2. Query aggregated tables for historical data
3. Use prepared statements for repeated queries
4. Batch inserts when adding multiple records
5. Run VACUUM periodically to optimize storage

### Security Notes

- Never commit auth tokens to git
- Use environment variables for credentials
- Rotate tokens periodically
- Limit database access to necessary operations only
- all test scripts should be saved in /scripts