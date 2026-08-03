-- Control plane for EV charge control: three ADDITIVE objects, no backfill, no data statement.
--
--   1. points.control jsonb NULL — a non-NULL value turns a read-only sensor point into a WRITABLE
--      actuator (the Home-Assistant entity-platform analogue: switch / number / button). NULL — the
--      value every existing row gets — means exactly what the absence of the column meant: read-only.
--      Nothing is backfilled here; the control values for the Tesla points land with a later PR.
--   2. point_commands — the command AUDIT TRAIL. One row per action dispatched at a writable point,
--      written 'pending' by the action route (or the automation evaluator) and completed in place
--      with the vendor outcome. Home Assistant keeps no command history; we do, so "why did my car
--      stop charging at 2am" is answerable from SQL a month later. Both FKs are NO ACTION: an audit
--      trail must never be silently destroyed by a delete elsewhere.
--   3. automations — the charge-limit store: mode='once' (this-session, self-disarming) or
--      'standing'. trigger/action are a closed v1 vocabulary held in jsonb; armed_context carries
--      per-arming state (the kWh baseline snapshotted at arm time). area_id is NO ACTION, exactly
--      like derivations.area_id.
--
-- Expand-only — but UNLIKE a pure add-a-table migration this one MUST be applied to prod BEFORE the
-- code that declares it deploys: drizzle's whole-table select in mintPoint (lib/point/mint-point.ts)
-- enumerates every schema column of `points`, so a deploy carrying points.control against a database
-- without it throws 42703 on the point-mint path. PG migrations here are manual.
-- Note also that `points` is a prod->dev sync manifest table whose schema parity is asserted on every
-- run, so dev and prod must be applied back-to-back or the 2-hourly sync fails fast until they match.
-- IF NOT EXISTS on the ALTER so a re-run after a partial apply is a no-op (cf. 0027, 0042, 0057).

CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mode" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"armed_at" timestamp,
	"last_triggered_at" timestamp,
	"last_triggered_run_start" timestamp,
	"armed_context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "automations_mode_check" CHECK ("automations"."mode" IN ('once','standing'))
);
--> statement-breakpoint
CREATE TABLE "point_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"point_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"action" text NOT NULL,
	"value" double precision,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"vendor_result" jsonb,
	"error" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "point_commands_status_check" CHECK ("point_commands"."status" IN ('pending','ok','rejected','failed'))
);
--> statement-breakpoint
ALTER TABLE "points" ADD COLUMN IF NOT EXISTS "control" jsonb;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_commands" ADD CONSTRAINT "point_commands_point_id_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."points"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_commands" ADD CONSTRAINT "point_commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automations_area_idx" ON "automations" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "point_commands_device_requested_idx" ON "point_commands" USING btree ("device_id","requested_at");--> statement-breakpoint
CREATE INDEX "point_commands_point_idx" ON "point_commands" USING btree ("point_id");
