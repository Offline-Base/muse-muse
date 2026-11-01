CREATE TABLE "glimmer_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"cap_usd" real NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"cost_usd" real,
	"adapter_job_id" uuid NOT NULL,
	"serve_job_id" uuid,
	"spark_open" boolean DEFAULT false NOT NULL,
	"reservation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "training_jobs" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "glimmer_windows" ADD CONSTRAINT "glimmer_windows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glimmer_windows" ADD CONSTRAINT "glimmer_windows_adapter_job_id_training_jobs_id_fk" FOREIGN KEY ("adapter_job_id") REFERENCES "public"."training_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glimmer_windows" ADD CONSTRAINT "glimmer_windows_serve_job_id_training_jobs_id_fk" FOREIGN KEY ("serve_job_id") REFERENCES "public"."training_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "glimmer_windows_one_open" ON "glimmer_windows" USING btree ("status") WHERE "glimmer_windows"."status" = 'open';--> statement-breakpoint
CREATE INDEX "glimmer_windows_created_idx" ON "glimmer_windows" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "training_jobs" ADD CONSTRAINT "training_jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_jobs_product_idx" ON "training_jobs" USING btree ("product_id","created_at");