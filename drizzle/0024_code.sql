CREATE TABLE "exec_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"kind" text NOT NULL,
	"principal" text NOT NULL,
	"subject_key" text,
	"language" text,
	"status" text NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "exec_runs" ADD CONSTRAINT "exec_runs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exec_runs_product_idx" ON "exec_runs" USING btree ("product_id","namespace","created_at");