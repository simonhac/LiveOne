CREATE SEQUENCE "public"."device_rid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "area_members" (
	"area_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "area_members_pk" PRIMARY KEY("area_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "device_state" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"last_poll_time" timestamp,
	"last_success_time" timestamp,
	"last_error_time" timestamp,
	"last_error" text,
	"last_response" jsonb,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"total_polls" integer DEFAULT 0 NOT NULL,
	"successful_polls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rid" integer NOT NULL,
	"owner_user_id" text,
	"vendor" text NOT NULL,
	"vendor_site_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"model" text,
	"serial" text,
	"primary_area_id" uuid,
	"config" jsonb,
	"adapter_state" jsonb,
	"commissioned_on" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "devices_status_check" CHECK ("devices"."status" IN ('active','disabled','removed'))
);
--> statement-breakpoint
CREATE TABLE "points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rid" integer NOT NULL,
	"device_id" uuid NOT NULL,
	"physical_path" text NOT NULL,
	"logical_path" text,
	"metric_type" text NOT NULL,
	"unit" text NOT NULL,
	"name" text NOT NULL,
	"default_name" text NOT NULL,
	"subsystem" text,
	"transform" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "area_members" ADD CONSTRAINT "area_members_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_members" ADD CONSTRAINT "area_members_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_state" ADD CONSTRAINT "device_state_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_primary_area_id_areas_id_fk" FOREIGN KEY ("primary_area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points" ADD CONSTRAINT "points_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_rid_unique" ON "devices" USING btree ("rid");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_owner_slug_unique" ON "devices" USING btree ("owner_user_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "points_rid_unique" ON "points" USING btree ("rid");--> statement-breakpoint
CREATE UNIQUE INDEX "points_device_physical_path_unique" ON "points" USING btree ("device_id","physical_path");--> statement-breakpoint
CREATE UNIQUE INDEX "points_device_logical_metric_unique" ON "points" USING btree ("device_id","logical_path","metric_type");--> statement-breakpoint
CREATE INDEX "points_device_idx" ON "points" USING btree ("device_id");