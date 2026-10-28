CREATE TABLE "training_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"task" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"requested" integer NOT NULL,
	"train" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eval" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"train_count" integer DEFAULT 0 NOT NULL,
	"eval_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"workflow_run_id" text
);
--> statement-breakpoint
ALTER TABLE "training_jobs" ADD COLUMN "eval_summary" jsonb;--> statement-breakpoint
ALTER TABLE "training_datasets" ADD CONSTRAINT "training_datasets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_datasets_created_idx" ON "training_datasets" USING btree ("created_at");