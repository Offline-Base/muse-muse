CREATE TABLE "code_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"token_id" uuid,
	"parent_token_id" uuid,
	"principal" text NOT NULL,
	"subject_key" text,
	"model" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"reason" text,
	"sandbox_name" text NOT NULL,
	"budget_usd" real NOT NULL,
	"limit_ms" integer NOT NULL,
	"sandbox_usage_id" uuid,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"binary_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"log_offset" integer DEFAULT 0 NOT NULL,
	"condense" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_event" integer DEFAULT 0 NOT NULL,
	"final_text" text,
	"exit_code" integer,
	"worked" boolean,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dropped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result_url" text,
	"result_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_token_id_gateway_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."gateway_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_parent_token_id_gateway_tokens_id_fk" FOREIGN KEY ("parent_token_id") REFERENCES "public"."gateway_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_sessions_product_idx" ON "code_sessions" USING btree ("product_id","status");--> statement-breakpoint
CREATE INDEX "code_sessions_status_idx" ON "code_sessions" USING btree ("status","ends_at");--> statement-breakpoint
CREATE INDEX "code_sessions_namespace_idx" ON "code_sessions" USING btree ("namespace","created_at");