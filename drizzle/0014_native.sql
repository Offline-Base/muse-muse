CREATE TABLE "native_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"platform" text,
	"device" text,
	"caption" text,
	"url" text NOT NULL,
	"pathname" text NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"sha256" text,
	"shell_version" text,
	"check_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "native_budget" (
	"lane" text PRIMARY KEY NOT NULL,
	"reserved_cents" integer DEFAULT 0 NOT NULL,
	"committed_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"kind" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"token_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "native_labs" (
	"lane" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"state" jsonb,
	"version" text,
	"instance_id" text
);
--> statement-breakpoint
CREATE TABLE "native_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"targets" jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"plan" jsonb,
	"summary" jsonb,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"workflow_run_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "native_spend" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lane" text NOT NULL,
	"kind" text NOT NULL,
	"usd" real NOT NULL,
	"ref" text,
	"run_id" uuid,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "requested_targets" jsonb;--> statement-breakpoint
ALTER TABLE "native_artifacts" ADD CONSTRAINT "native_artifacts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_artifacts" ADD CONSTRAINT "native_artifacts_run_id_native_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."native_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_artifacts" ADD CONSTRAINT "native_artifacts_job_id_native_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."native_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_jobs" ADD CONSTRAINT "native_jobs_run_id_native_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."native_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_jobs" ADD CONSTRAINT "native_jobs_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_jobs" ADD CONSTRAINT "native_jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_runs" ADD CONSTRAINT "native_runs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_runs" ADD CONSTRAINT "native_runs_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_runs" ADD CONSTRAINT "native_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_spend" ADD CONSTRAINT "native_spend_run_id_native_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."native_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_artifacts_product_idx" ON "native_artifacts" USING btree ("product_id","kind","superseded_at");--> statement-breakpoint
CREATE INDEX "native_artifacts_run_idx" ON "native_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "native_jobs_claim_idx" ON "native_jobs" USING btree ("lane","status","priority","created_at");--> statement-breakpoint
CREATE INDEX "native_jobs_run_idx" ON "native_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "native_jobs_build_idx" ON "native_jobs" USING btree ("build_id");--> statement-breakpoint
CREATE UNIQUE INDEX "native_runs_once_idx" ON "native_runs" USING btree ("build_id","origin") WHERE "native_runs"."origin" in ('ship', 'refine');--> statement-breakpoint
CREATE INDEX "native_runs_product_idx" ON "native_runs" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "native_spend_lane_idx" ON "native_spend" USING btree ("lane","at");--> statement-breakpoint
CREATE INDEX "native_spend_run_idx" ON "native_spend" USING btree ("run_id");