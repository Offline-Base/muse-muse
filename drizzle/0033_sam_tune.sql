CREATE TABLE "sam_tune_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"word" text NOT NULL,
	"generic" text NOT NULL,
	"data" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"distractors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seed" integer NOT NULL,
	"epochs" integer NOT NULL,
	"stage" jsonb,
	"report" jsonb,
	"error" text,
	"uploads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"max_usd" real NOT NULL,
	"lease_until" timestamp with time zone,
	"worker_id" text,
	"job_token_hash" text,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"shown" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sam_workers" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"free_mem_mb" integer NOT NULL,
	"free_disk_mb" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sam_tune_runs" ADD CONSTRAINT "sam_tune_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sam_tune_one_active" ON "sam_tune_runs" USING btree ((true)) WHERE "sam_tune_runs"."status" in ('claimed', 'running');--> statement-breakpoint
CREATE INDEX "sam_tune_queue_idx" ON "sam_tune_runs" USING btree ("status","created_at");