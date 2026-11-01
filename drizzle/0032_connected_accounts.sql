CREATE TABLE "code_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_key" text NOT NULL,
	"external_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"branch" text NOT NULL,
	"is_private" boolean NOT NULL,
	"last_commit_sha" text,
	"last_version_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_key" text NOT NULL,
	"external_id" text NOT NULL,
	"external_login" text NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "code_exports" ADD CONSTRAINT "code_exports_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_exports_owner_idx" ON "code_exports" USING btree ("product_id","provider","owner_kind","owner_key");--> statement-breakpoint
CREATE UNIQUE INDEX "connected_accounts_active_idx" ON "connected_accounts" USING btree ("provider","owner_kind","owner_key") WHERE "connected_accounts"."revoked_at" is null;