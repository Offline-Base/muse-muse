CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"mcp_url_ciphertext" "bytea",
	"token_ciphertext" "bytea",
	"endpoint_url_ciphertext" "bytea",
	"iv" "bytea",
	"tag" "bytea",
	"url_iv" "bytea",
	"url_tag" "bytea",
	"key_version" integer,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lan" boolean DEFAULT false NOT NULL,
	"trust" text NOT NULL,
	"cert_spki_sha256" text,
	"pair_code_hash" text,
	"paired_at" timestamp with time zone,
	"allow_plain_http" boolean DEFAULT false NOT NULL,
	"health" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_boards" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"visitors" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_boards" ADD CONSTRAINT "product_boards_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_boards" ADD CONSTRAINT "product_boards_board_id_devices_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_owner_idx" ON "devices" USING btree ("owner_user_id","kind");--> statement-breakpoint
CREATE INDEX "product_boards_board_idx" ON "product_boards" USING btree ("board_id");