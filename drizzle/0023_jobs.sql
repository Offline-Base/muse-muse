CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"schedule_id" uuid,
	"webhook_id" uuid,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"namespace" text DEFAULT 'live' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"tick" integer DEFAULT 0 NOT NULL,
	"checkpoint" jsonb,
	"input" jsonb,
	"budget_usd" real NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "owner_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text DEFAULT 'live' NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"every_minutes" integer NOT NULL,
	"at_minute" integer,
	"tz" text DEFAULT 'UTC' NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text DEFAULT 'live' NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "owner_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_schedule_id_product_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."product_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_webhook_id_product_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."product_webhooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_notices" ADD CONSTRAINT "owner_notices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_schedules" ADD CONSTRAINT "product_schedules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_webhooks" ADD CONSTRAINT "product_webhooks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_runs_status_idx" ON "job_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_runs_product_idx" ON "job_runs" USING btree ("product_id","namespace","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_active_schedule_idx" ON "job_runs" USING btree ("schedule_id") WHERE "job_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "owner_notices_product_idx" ON "owner_notices" USING btree ("product_id","namespace","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_schedules_name_idx" ON "product_schedules" USING btree ("product_id","name");--> statement-breakpoint
CREATE INDEX "product_schedules_due_idx" ON "product_schedules" USING btree ("next_run_at") WHERE "product_schedules"."paused_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_webhooks_active_idx" ON "product_webhooks" USING btree ("product_id","namespace","name") WHERE "product_webhooks"."revoked_at" is null;