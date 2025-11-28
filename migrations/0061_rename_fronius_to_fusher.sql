-- Migration: Rename fronius vendor to fusher

BEGIN TRANSACTION;

-- Update systems table
UPDATE systems SET vendor_type = 'fusher' WHERE vendor_type = 'fronius';

COMMIT;

-- Track migration
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO migrations (id) VALUES ('0061_rename_fronius_to_fusher');
