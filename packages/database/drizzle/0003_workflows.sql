CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"kind_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"interval_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_proposals" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_slot_uq" ON "workflow_runs" USING btree ("workflow_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "workflows_due_idx" ON "workflows" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "workflows_owner_idx" ON "workflows" USING btree ("customer_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_dedupe_uq" ON "action_proposals" USING btree ("customer_id","dedupe_key");