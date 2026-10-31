CREATE TABLE "tool_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"composio_user_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"composio_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"config_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "tool_fixtures" jsonb;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_sessions" ADD CONSTRAINT "tool_sessions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connections_active_idx" ON "tool_connections" USING btree ("product_id","composio_user_id","toolkit") WHERE "tool_connections"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "tool_connections_product_idx" ON "tool_connections" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_sessions_user_idx" ON "tool_sessions" USING btree ("product_id","composio_user_id");