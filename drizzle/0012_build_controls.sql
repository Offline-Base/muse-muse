ALTER TABLE "builds" ADD COLUMN "muse_round" integer;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "stop_requested" boolean DEFAULT false NOT NULL;