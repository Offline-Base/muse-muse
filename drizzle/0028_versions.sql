CREATE TABLE "product_versions" (
	"build_id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"files" jsonb NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"restored_from" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "product_versions_product_idx" ON "product_versions" USING btree ("product_id");
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source_public" boolean DEFAULT false NOT NULL;
