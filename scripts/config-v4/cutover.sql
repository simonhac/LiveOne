-- config-v4 cutover — structural DDL (the "0035" schema delta)
--
-- ⚠️  NOT a journalled drizzle migration (deliberately). It creates the destructive cutover schema
--     (devices/points/…) and must NEVER be applied by a routine `db:pg:migrate`. It is applied ONLY:
--       • by scripts/config-v4/config-transform.ts, on a throwaway prod-snapshot branch (Phase 7); and
--       • at the real Phase 8 cutover, promoted to a journalled migration alongside the schema.ts overhaul.
--     Applying it never touches the live serving tables — it only ADDS new empty tables + a sequence.
--
-- Idempotent (IF NOT EXISTS) so a fresh-branch rehearsal that half-ran can re-drive. FK order:
--   areas (exists) → devices → points → area_members → device_state.
-- Data population + the hot-table rid-rewrite live in config-transform.ts (batched, can't be one txn).
-- Statements are separated by `--> statement-breakpoint` (the driver splits on it).

-- Internal recorder key for devices: preserves today's systems.id values (sessions/outbox keep an int
-- device_rid == old system_id), so it is seeded at max(systems.id)+1 by the driver, never here.
CREATE SEQUENCE IF NOT EXISTS "device_rid_seq";--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "devices" (
	"id"              uuid PRIMARY KEY NOT NULL,
	"rid"             integer NOT NULL,
	"owner_user_id"   text,
	"vendor"          text NOT NULL,
	"vendor_site_id"  text NOT NULL,
	"status"          text DEFAULT 'active' NOT NULL,
	"name"            text NOT NULL,
	"slug"            text,
	"model"           text,
	"serial"          text,
	-- eager area; tz/location resolve here. Created NULLABLE; the driver mints areas-of-one, sets it,
	-- then tightens to NOT NULL (2d). FK → areas(id) (areas already exists in final uuid form).
	"primary_area_id" uuid,
	"config"          jsonb,
	"adapter_state"   jsonb,
	"commissioned_on" date,
	"created_at"      timestamp DEFAULT now() NOT NULL,
	"updated_at"      timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "devices_rid_unique" UNIQUE("rid"),
	CONSTRAINT "devices_status_check" CHECK ("devices"."status" IN ('active','disabled','removed')),
	CONSTRAINT "devices_primary_area_id_areas_fk" FOREIGN KEY ("primary_area_id") REFERENCES "areas"("id")
);--> statement-breakpoint
-- owner-scoped pretty-URL slug (NULLs distinct); mirrors areas_owner_alias_unique.
CREATE UNIQUE INDEX IF NOT EXISTS "devices_owner_slug_unique" ON "devices" ("owner_user_id","slug");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "points" (
	"id"            uuid PRIMARY KEY NOT NULL,          -- = point_info.point_uid (verbatim identity)
	"rid"           integer NOT NULL,                   -- = point_info.rid (verbatim; seam invariant)
	"device_id"     uuid NOT NULL,
	"physical_path" text NOT NULL,
	"logical_path"  text,
	"metric_type"   text NOT NULL,
	"unit"          text NOT NULL,
	"name"          text NOT NULL,
	"default_name"  text NOT NULL,
	"subsystem"     text,
	"transform"     text,
	"active"        boolean DEFAULT true NOT NULL,
	"created_at"    timestamp DEFAULT now() NOT NULL,
	"updated_at"    timestamp,
	CONSTRAINT "points_rid_unique" UNIQUE("rid"),
	CONSTRAINT "points_device_id_devices_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "points_device_physical_path_unique" ON "points" ("device_id","physical_path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "points_device_logical_metric_unique" ON "points" ("device_id","logical_path","metric_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "points_device_idx" ON "points" ("device_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "area_members" (
	"area_id"   uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"ordinal"   integer DEFAULT 0 NOT NULL,
	CONSTRAINT "area_members_pk" PRIMARY KEY("area_id","device_id"),
	CONSTRAINT "area_members_area_id_areas_fk"     FOREIGN KEY ("area_id")   REFERENCES "areas"("id")   ON DELETE CASCADE,
	CONSTRAINT "area_members_device_id_devices_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE
);--> statement-breakpoint

-- 1:1 operational-state satellite of devices (was polling_status). Written every poll; never exported.
CREATE TABLE IF NOT EXISTS "device_state" (
	"device_id"          uuid PRIMARY KEY NOT NULL,
	"last_poll_time"     timestamp,
	"last_success_time"  timestamp,
	"last_error_time"    timestamp,
	"last_error"         text,
	"last_response"      jsonb,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"total_polls"        integer DEFAULT 0 NOT NULL,
	"successful_polls"   integer DEFAULT 0 NOT NULL,
	"updated_at"         timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_state_device_id_devices_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE
);
