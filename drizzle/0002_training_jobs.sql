CREATE TABLE "training_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"params" jsonb NOT NULL,
	"instance_type" text NOT NULL,
	"region" text NOT NULL,
	"price_cents_per_hour" integer NOT NULL,
	"max_minutes" integer NOT NULL,
	"max_usd" real NOT NULL,
	"instance_id" text,
	"instance_name" text NOT NULL,
	"instance_ip" text,
	"token_hash" text,
	"workflow_run_id" text,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"progress" jsonb,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"error" text,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone,
	"first_heartbeat_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"terminated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "training_events" ADD CONSTRAINT "training_events_job_id_training_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."training_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_jobs" ADD CONSTRAINT "training_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_events_job_idx" ON "training_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "training_jobs_status_idx" ON "training_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "training_jobs_created_idx" ON "training_jobs" USING btree ("created_at");