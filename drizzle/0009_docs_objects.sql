CREATE TABLE "docs_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"visitor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "docs_objects_visitor_idx" ON "docs_objects" USING btree ("visitor","kind");--> statement-breakpoint
CREATE INDEX "docs_objects_kind_created_idx" ON "docs_objects" USING btree ("kind","created_at");