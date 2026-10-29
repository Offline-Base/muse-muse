CREATE TABLE "drive_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"secret_hash" text NOT NULL,
	"training_job_id" uuid NOT NULL,
	"build" text NOT NULL,
	"gguf_repo" text NOT NULL,
	"gguf_commit" text NOT NULL,
	"files" jsonb NOT NULL,
	"model" jsonb NOT NULL,
	"image_version" text NOT NULL,
	"name" text,
	"email" text,
	"address" jsonb,
	"invoice_ref" text,
	"amount_text" text,
	"note" text,
	"terms_version" text NOT NULL,
	"terms_accepted_at" timestamp with time zone NOT NULL,
	"age_ok_at" timestamp with time zone NOT NULL,
	"client_key" text,
	"browser_key" text,
	"serial" text,
	"verify_result" text,
	"manifest_sha256" text,
	"carrier" text,
	"tracking" text,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoiced_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"flashing_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_orders_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "drive_orders" ADD CONSTRAINT "drive_orders_training_job_id_training_jobs_id_fk" FOREIGN KEY ("training_job_id") REFERENCES "public"."training_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_orders_created_idx" ON "drive_orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "drive_orders_status_idx" ON "drive_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drive_orders_client_idx" ON "drive_orders" USING btree ("client_key","created_at");--> statement-breakpoint
CREATE INDEX "drive_orders_browser_idx" ON "drive_orders" USING btree ("browser_key","created_at");