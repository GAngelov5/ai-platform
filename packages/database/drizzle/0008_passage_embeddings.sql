-- pgvector (ADR 0017). Needs a role allowed to create extensions, or a DBA who ran it beforehand.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "passage_embeddings" (
	"customer_id" text NOT NULL,
	"document_id" text NOT NULL,
	"chunk_id" text NOT NULL,
	"model" text NOT NULL,
	"version" text NOT NULL,
	"format" text NOT NULL,
	"dims" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passage_embeddings_customer_id_document_id_chunk_id_model_pk" PRIMARY KEY("customer_id","document_id","chunk_id","model")
);
--> statement-breakpoint
ALTER TABLE "passage_embeddings" ADD CONSTRAINT "passage_embeddings_customer_id_document_id_document_content_customer_id_document_id_fk" FOREIGN KEY ("customer_id","document_id") REFERENCES "public"."document_content"("customer_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passage_embeddings_doc_idx" ON "passage_embeddings" USING btree ("customer_id","model","document_id","version");