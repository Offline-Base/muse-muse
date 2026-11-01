ALTER TABLE "training_datasets" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "training_datasets" ADD COLUMN "decision" jsonb;--> statement-breakpoint
ALTER TABLE "training_datasets" ADD COLUMN "decision_rows" jsonb DEFAULT '{}'::jsonb NOT NULL;