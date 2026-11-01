CREATE TABLE "board_loops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adapter_job_id" uuid NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stages" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"try_open" boolean DEFAULT false NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"workflow_run_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_try_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loop_id" uuid NOT NULL,
	"visitor" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"prompt" text,
	"answer" text,
	"tokens" integer,
	"tokens_per_second" real,
	"ms" integer,
	"error" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_loops" ADD CONSTRAINT "board_loops_adapter_job_id_training_jobs_id_fk" FOREIGN KEY ("adapter_job_id") REFERENCES "public"."training_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_loops" ADD CONSTRAINT "board_loops_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_try_turns" ADD CONSTRAINT "board_try_turns_loop_id_board_loops_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."board_loops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_loops_one_active" ON "board_loops" USING btree ("target") WHERE "board_loops"."status" in ('running', 'serving');--> statement-breakpoint
CREATE INDEX "board_loops_adapter_idx" ON "board_loops" USING btree ("adapter_job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "board_try_one_running" ON "board_try_turns" USING btree ("loop_id") WHERE "board_try_turns"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "board_try_one_open" ON "board_try_turns" USING btree ("loop_id","visitor") WHERE "board_try_turns"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "board_try_queue_idx" ON "board_try_turns" USING btree ("loop_id","status","created_at");