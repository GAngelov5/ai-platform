ALTER TABLE "source_sync_state" ADD COLUMN "sync_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_sync_state" ADD COLUMN "sync_requested_by" text;