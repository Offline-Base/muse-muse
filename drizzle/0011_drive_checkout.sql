ALTER TABLE "drive_orders" ADD COLUMN "payment" text DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_orders" ADD COLUMN "checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "drive_orders" ADD COLUMN "refund_ref" text;