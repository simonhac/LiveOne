# Migration Logs

This directory contains log files from point system migrations.

## Log Files

Each migration creates timestamped log files with full output:

- **Production migrations**:
  - `prod-readings-migration.log` - Raw readings migration
  - `prod-agg-migration.log` - Aggregation migration
  - `prod-readings-validation.log` - Readings validation
  - `prod-agg-validation.log` - Aggregation validation

- **Test migrations** (on production backup):
  - `test-readings-migration.log`
  - `test-agg-migration.log`
  - `test-readings-validation.log`
  - `test-agg-validation.log`

- **Dev migrations**:
  - `test-migration.log` - Development testing

## Log Format

Each log line includes an ISO timestamp:

```
[2025-11-06 16:50:23.456] 🔄 Point System Migration Tool
[2025-11-06 16:50:23.457] ================================
[2025-11-06 16:50:24.123] 📊 Analyzing system 1 (selectronic)...
[2025-11-06 16:50:24.234]   Total readings: 71,982
```

Error lines are prefixed with `[ERROR]`:

```
[2025-11-06 16:50:30.123] [ERROR] Migration failed: Connection timeout
```

## Usage

### Automatic Logging

Use the commands in `TODO.md` which automatically log to this directory:

```bash
# Example from TODO.md
npm run migrate:points -- --production 2>&1 | tee log/prod-readings-migration.log
```

### Manual Logging

Or use the `--log-file` option directly:

```bash
npm run migrate:points -- --database /tmp/test.db --log-file log/my-test.log
npm run migrate:agg5m -- --production --log-file log/prod-agg.log
```

## Retention

Log files should be kept for:

- **Production migrations**: Permanently (archive after deprecation)
- **Test migrations**: Keep until production migration complete
- **Dev/test logs**: Can be deleted after verification

## Archive

After successful production migration, archive the log directory:

```bash
# Create archive with timestamp
tar -czf log-archive-$(date +%Y%m%d).tar.gz log/

# Move to permanent storage
mv log-archive-*.tar.gz ~/backups/liveone-migrations/
```
