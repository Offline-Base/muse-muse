CREATE TABLE "product_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text DEFAULT 'live' NOT NULL,
	"name" text NOT NULL,
	"service" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"test_hash" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "product_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text DEFAULT 'live' NOT NULL,
	"channel" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"recipients" integer DEFAULT 1 NOT NULL,
	"approval_nonce" text NOT NULL,
	"status" text NOT NULL,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_sends_approval_nonce_unique" UNIQUE("approval_nonce")
);--> statement-breakpoint
CREATE TABLE "public_fetch_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"api" text NOT NULL,
	"status" integer NOT NULL,
	"content_type" text,
	"body" "bytea" NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "product_secrets" ADD CONSTRAINT "product_secrets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sends" ADD CONSTRAINT "product_sends_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_secrets_active_idx" ON "product_secrets" USING btree ("product_id","namespace","name") WHERE "product_secrets"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "product_sends_product_idx" ON "product_sends" USING btree ("product_id","namespace","created_at");--> statement-breakpoint
CREATE INDEX "public_fetch_cache_expires_idx" ON "public_fetch_cache" USING btree ("expires_at");