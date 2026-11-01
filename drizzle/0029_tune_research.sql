CREATE TABLE "training_research" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"error" text,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"max_usd" real NOT NULL,
	"workflow_run_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "training_datasets" ADD COLUMN "grounding" text;--> statement-breakpoint
ALTER TABLE "training_research" ADD CONSTRAINT "training_research_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_research_created_idx" ON "training_research" USING btree ("created_at");