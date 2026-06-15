ALTER TABLE "point_info" ADD COLUMN "point_uid" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "pi_point_uid_unique" ON "point_info" USING btree ("point_uid");