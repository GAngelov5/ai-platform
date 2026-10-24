CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"provider" text NOT NULL,
	"browser_nonce_hash" text NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_email" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_sealed" text NOT NULL,
	"refresh_token_sealed" text,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "personal_connections_owner_uq" ON "personal_connections" USING btree ("customer_id","principal_id","provider");