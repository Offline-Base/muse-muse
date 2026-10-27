CREATE TABLE "build_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"build_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspiration_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'build' NOT NULL,
	"message" text,
	"rebuild_of" text,
	"product_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"brief" jsonb,
	"build_model" text,
	"sandbox_name" text,
	"muse_session_id" text,
	"workflow_run_id" text,
	"fix_rounds" integer DEFAULT 0 NOT NULL,
	"preview_url" text,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gateway_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text NOT NULL,
	"allowed_models" jsonb NOT NULL,
	"daily_budget_usd" real NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "inspirations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"note" text,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"owner_id" uuid NOT NULL,
	"inspiration_id" uuid,
	"rebuild_of" text,
	"manifest" jsonb,
	"latest_build_id" uuid,
	"sandbox_name" text,
	"muse_session_id" text,
	"vercel_project_id" text,
	"live_url" text,
	"demo_video_url" text,
	"transcript_url" text,
	"status" text DEFAULT 'building' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"product_id" uuid,
	"build_id" uuid,
	"token_id" uuid,
	"endpoint" text NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"video_frames" integer DEFAULT 0 NOT NULL,
	"audio_seconds" real DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"daily_build_quota" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "build_events" ADD CONSTRAINT "build_events_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_inspiration_id_inspirations_id_fk" FOREIGN KEY ("inspiration_id") REFERENCES "public"."inspirations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_tokens" ADD CONSTRAINT "gateway_tokens_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspirations" ADD CONSTRAINT "inspirations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_inspiration_id_inspirations_id_fk" FOREIGN KEY ("inspiration_id") REFERENCES "public"."inspirations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_token_id_gateway_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."gateway_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_events_build_id_idx" ON "build_events" USING btree ("build_id","id");--> statement-breakpoint
CREATE INDEX "builds_inspiration_idx" ON "builds" USING btree ("inspiration_id");--> statement-breakpoint
CREATE INDEX "builds_product_idx" ON "builds" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "builds_user_started_idx" ON "builds" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "builds_rebuild_idx" ON "builds" USING btree ("rebuild_of");--> statement-breakpoint
CREATE INDEX "gateway_tokens_product_idx" ON "gateway_tokens" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inspirations_user_idx" ON "inspirations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "products_owner_idx" ON "products" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "products_rebuild_idx" ON "products" USING btree ("rebuild_of");--> statement-breakpoint
CREATE INDEX "usage_product_at_idx" ON "usage" USING btree ("product_id","at");--> statement-breakpoint
CREATE INDEX "usage_token_at_idx" ON "usage" USING btree ("token_id","at");--> statement-breakpoint
CREATE INDEX "usage_build_idx" ON "usage" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "usage_at_idx" ON "usage" USING btree ("at");