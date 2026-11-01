CREATE TABLE "product_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"scope" text NOT NULL,
	"owner_key" text,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text,
	"blob_path" text NOT NULL,
	"store" text DEFAULT 'public' NOT NULL,
	"ticket_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_search_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"scope" text NOT NULL,
	"owner_key" text,
	"added_by" text,
	"source" jsonb NOT NULL,
	"source_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"chunk" integer DEFAULT 0 NOT NULL,
	"offset" integer DEFAULT 0 NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title", '') || ' ' || coalesce("body", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_dataset_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"dataset_id" text NOT NULL,
	"file" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_files" ADD CONSTRAINT "product_files_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_search_docs" ADD CONSTRAINT "product_search_docs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_dataset_reads" ADD CONSTRAINT "product_dataset_reads_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_files_list_idx" ON "product_files" USING btree ("product_id","namespace","scope","owner_key","created_at");--> statement-breakpoint
CREATE INDEX "product_files_status_idx" ON "product_files" USING btree ("product_id","namespace","status");--> statement-breakpoint
CREATE INDEX "product_search_docs_tsv_idx" ON "product_search_docs" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "product_search_docs_source_idx" ON "product_search_docs" USING btree ("product_id","namespace","source_key");--> statement-breakpoint
CREATE INDEX "product_dataset_reads_idx" ON "product_dataset_reads" USING btree ("product_id","namespace","created_at");