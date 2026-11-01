CREATE TABLE "hosted_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adapter_job_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"slot" integer NOT NULL,
	"name" text NOT NULL,
	"ref" jsonb,
	"hourly_usd" real NOT NULL,
	"reserved_usd" real NOT NULL,
	"cost_usd" real,
	"reservation_id" uuid,
	"owner_token_hash" text NOT NULL,
	"created_by" uuid,
	"stop_reason" text,
	"stops_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hosted_endpoints" ADD CONSTRAINT "hosted_endpoints_adapter_job_id_training_jobs_id_fk" FOREIGN KEY ("adapter_job_id") REFERENCES "public"."training_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_endpoints" ADD CONSTRAINT "hosted_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_endpoints_one_per_model" ON "hosted_endpoints" USING btree ("adapter_job_id") WHERE "hosted_endpoints"."status" in ('starting', 'live', 'stopping');--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_endpoints_one_per_slot" ON "hosted_endpoints" USING btree ("slot") WHERE "hosted_endpoints"."status" in ('starting', 'live', 'stopping');--> statement-breakpoint
CREATE INDEX "hosted_endpoints_created_idx" ON "hosted_endpoints" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "hosted_endpoints_owner_token_idx" ON "hosted_endpoints" USING btree ("owner_token_hash");