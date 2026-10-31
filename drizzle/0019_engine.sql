ALTER TABLE "builds" ADD COLUMN "round_plan" jsonb;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "live_check" jsonb;--> statement-breakpoint
ALTER TABLE "gateway_tokens" ADD COLUMN "build_id" uuid;--> statement-breakpoint
ALTER TABLE "gateway_tokens" ADD CONSTRAINT "gateway_tokens_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_tokens_build_idx" ON "gateway_tokens" USING btree ("build_id");