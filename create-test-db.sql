-- Create test database matching production schema
CREATE TABLE "systems" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  system_number TEXT NOT NULL,
  display_name TEXT,
  model TEXT,
  serial TEXT,
  ratings TEXT,
  solar_size TEXT,
  battery_size TEXT,
  created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE "readings" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  inverter_time INTEGER NOT NULL,
  received_time INTEGER NOT NULL,
  delay_seconds INTEGER,
  solar_power REAL NOT NULL,
  solar_inverter_power REAL,
  shunt_power REAL,
  load_power REAL NOT NULL,
  battery_power REAL NOT NULL,
  grid_power REAL NOT NULL,
  battery_soc REAL NOT NULL,
  fault_code INTEGER DEFAULT 0,
  fault_timestamp INTEGER DEFAULT 0,
  generator_status INTEGER DEFAULT 0,
  solar_kwh_total REAL DEFAULT 0,
  load_kwh_total REAL DEFAULT 0,
  battery_in_kwh_total REAL DEFAULT 0,
  battery_out_kwh_total REAL DEFAULT 0,
  grid_in_kwh_total REAL DEFAULT 0,
  grid_out_kwh_total REAL DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()) NOT NULL, 
  solar_w INTEGER, 
  solar_inverter_w INTEGER, 
  shunt_w INTEGER, 
  load_w INTEGER, 
  battery_w INTEGER, 
  grid_w INTEGER,
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);

CREATE TABLE "polling_status" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  last_poll_time INTEGER,
  last_success_time INTEGER,
  last_error_time INTEGER,
  last_error TEXT,
  last_response TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  total_polls INTEGER NOT NULL DEFAULT 0,
  successful_polls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);

-- Insert test data
INSERT INTO systems (id, user_id, system_number, created_at, updated_at) 
VALUES (1, 'simon', '123456', '2025-08-16 02:00:00', '2025-08-16 02:00:00');

-- Insert sample readings with text timestamps like production
INSERT INTO readings (system_id, inverter_time, received_time, solar_power, load_power, battery_power, grid_power, battery_soc, created_at)
VALUES 
(1, 1755310673, 1755310675, 1500.5, 300.2, -1200.3, 0, 85.5, '2025-08-16 02:17:55'),
(1, 1755310733, 1755310735, 1600.5, 350.2, -1250.3, 0, 86.0, '2025-08-16 02:18:55'),
(1, 1755310793, 1755310795, 1700.5, 400.2, -1300.3, 0, 86.5, '2025-08-16 02:19:55');

INSERT INTO polling_status (system_id, updated_at)
VALUES (1, '2025-08-16 02:20:00');