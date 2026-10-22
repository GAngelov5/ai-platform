CREATE TABLE "document_content" (
	"customer_id" text NOT NULL,
	"document_id" text NOT NULL,
	"version" text NOT NULL,
	"mime_type" text NOT NULL,
	"text" text NOT NULL,
	"content_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_content_customer_id_document_id_pk" PRIMARY KEY("customer_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "source_quarantine" (
	"customer_id" text NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"version" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_quarantine_customer_id_source_id_external_id_pk" PRIMARY KEY("customer_id","source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "source_sync_state" (
	"customer_id" text NOT NULL,
	"source_id" text NOT NULL,
	"cursor" text,
	"last_run" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_sync_state_customer_id_source_id_pk" PRIMARY KEY("customer_id","source_id")
);
