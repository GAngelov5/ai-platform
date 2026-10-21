CREATE TABLE "action_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"conversation_id" uuid,
	"run_id" uuid,
	"capability_id" text NOT NULL,
	"capability_version" text NOT NULL,
	"connector_id" text NOT NULL,
	"tool" text NOT NULL,
	"operation" text NOT NULL,
	"destination" text NOT NULL,
	"risk" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"approved_by" text,
	"decided_at" timestamp with time zone,
	"receipt" jsonb,
	"last_error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"approver_principal_id" text NOT NULL,
	"decision" text NOT NULL,
	"payload_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" text,
	"error_kind" text,
	"receipt" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "live_evidence" (
	"evidence_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"capability_version" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"args_hash" text,
	"error_kind" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "proposal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_idem_uq" ON "action_proposals" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "action_proposals_owner_idx" ON "action_proposals" USING btree ("customer_id","principal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_attempts_uq" ON "execution_attempts" USING btree ("proposal_id","attempt");--> statement-breakpoint
CREATE INDEX "live_evidence_principal_idx" ON "live_evidence" USING btree ("customer_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_dedupe_uq" ON "outbox_events" USING btree ("type","aggregate_id");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("processed_at","available_at");--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id");