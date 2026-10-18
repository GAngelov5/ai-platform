CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"conversation_id" uuid,
	"request_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"status" text NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"model" jsonb,
	"usage" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text,
	"request_id" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"outcome" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issued_evidence" (
	"evidence_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"run_id" uuid,
	"request_id" text NOT NULL,
	"source_id" text NOT NULL,
	"document_id" text NOT NULL,
	"version" text NOT NULL,
	"chunk_id" text NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"source_url" text,
	"indexed_at" timestamp with time zone NOT NULL,
	"excerpt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"status" text,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" jsonb,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text NOT NULL,
	"customer_id" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_customer_id_id_pk" PRIMARY KEY("customer_id","id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"auth_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"customer_id" text NOT NULL,
	"document_id" text NOT NULL,
	"source_id" text NOT NULL,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"acl_groups" jsonb NOT NULL,
	"acl_revision" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"indexed_at" timestamp with time zone NOT NULL,
	"tombstoned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_documents_customer_id_document_id_pk" PRIMARY KEY("customer_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_principal_idx" ON "agent_runs" USING btree ("customer_id","principal_id","started_at");--> statement-breakpoint
CREATE INDEX "audit_events_customer_idx" ON "audit_events" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_owner_idx" ON "conversations" USING btree ("customer_id","owner_principal_id","updated_at");--> statement-breakpoint
CREATE INDEX "issued_evidence_principal_idx" ON "issued_evidence" USING btree ("customer_id","principal_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_principal_idx" ON "sessions" USING btree ("customer_id","principal_id");--> statement-breakpoint
CREATE INDEX "source_documents_source_idx" ON "source_documents" USING btree ("customer_id","source_id");