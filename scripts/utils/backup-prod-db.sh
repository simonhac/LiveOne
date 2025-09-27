#!/bin/bash

# Script to backup production database to db-backups/
# Usage: ./scripts/backup-prod-db.sh

set -e  # Exit on error

# Generate timestamp once
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILENAME="liveone-tokyo-${TIMESTAMP}.db"
BACKUP_DIR="db-backups"

# Ensure backup directory exists
mkdir -p ${BACKUP_DIR}

echo "Starting backup of liveone-tokyo production database..."
echo "Timestamp: ${TIMESTAMP}"

# Export database with timestamp in filename
echo "Exporting database..."
~/.turso/turso db export liveone-tokyo --output-file "${FILENAME}"

# Compress the backup
echo "Compressing backup..."
gzip "${FILENAME}"

# Move to backup directory
echo "Moving to ${BACKUP_DIR}/..."
mv "${FILENAME}.gz" "${BACKUP_DIR}/"

# Show result
echo "✓ Backup completed successfully!"
echo "  File: ${BACKUP_DIR}/${FILENAME}.gz"
echo "  Size: $(ls -lh ${BACKUP_DIR}/${FILENAME}.gz | awk '{print $5}')"

# Optional: Show recent backups
echo ""
echo "Recent backups:"
ls -lht ${BACKUP_DIR}/liveone-tokyo-*.gz 2>/dev/null | head -5 || echo "No backups found"