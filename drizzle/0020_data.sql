CREATE SEQUENCE "public"."product_rows_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "end_user_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"end_user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "end_user_passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "end_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_data_counts" (
	"product_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "product_data_counts_product_id_namespace_pk" PRIMARY KEY("product_id","namespace")
);
--> statement-breakpoint
CREATE TABLE "product_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"collection" text NOT NULL,
	"scope" text NOT NULL,
	"owner_key" text,
	"doc_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"seq" bigint DEFAULT nextval('product_rows_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_rows_key" UNIQUE NULLS NOT DISTINCT("product_id","namespace","collection","scope","owner_key","doc_id")
);
--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "caps_dropped" jsonb;--> statement-breakpoint
ALTER TABLE "end_user_passkeys" ADD CONSTRAINT "end_user_passkeys_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_data_counts" ADD CONSTRAINT "product_data_counts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_rows" ADD CONSTRAINT "product_rows_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "end_user_passkeys_user_idx" ON "end_user_passkeys" USING btree ("end_user_id");--> statement-breakpoint
CREATE INDEX "product_rows_seq_idx" ON "product_rows" USING btree ("product_id","namespace","seq");--> statement-breakpoint
CREATE INDEX "product_rows_owner_idx" ON "product_rows" USING btree ("product_id","namespace","owner_key");