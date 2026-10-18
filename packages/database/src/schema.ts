import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const principals = pgTable(
  "principals",
  {
    id: text("id").notNull(),
    customerId: text("customer_id").notNull().references(() => customers.id),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    groups: jsonb("groups").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    roles: jsonb("roles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** "fixture" principals may only authenticate through development auth. */
    origin: text("origin").$type<"fixture" | "oidc">().notNull(),
    disabled: boolean("disabled").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.id] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    customerId: text("customer_id").notNull(),
    principalId: text("principal_id").notNull(),
    authMode: text("auth_mode").$type<"dev" | "oidc">().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_principal_idx").on(t.customerId, t.principalId)],
);

/** Platform-owned catalog: identity, version and ACL of every indexed source document. */
export const sourceDocuments = pgTable(
  "source_documents",
  {
    customerId: text("customer_id").notNull().references(() => customers.id),
    documentId: text("document_id").notNull(),
    sourceId: text("source_id").notNull(),
    version: text("version").notNull(),
    title: text("title").notNull(),
    sourceUrl: text("source_url"),
    aclGroups: jsonb("acl_groups").$type<string[]>().notNull(),
    aclRevision: integer("acl_revision").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    /** Adapter-specific reference, e.g. { ragflowDatasetId, ragflowDocumentId }. */
    externalRef: jsonb("external_ref").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    indexedAt: ts("indexed_at").notNull(),
    tombstonedAt: ts("tombstoned_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.documentId] }), index("source_documents_source_idx").on(t.customerId, t.sourceId)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id").notNull(),
    ownerPrincipalId: text("owner_principal_id").notNull(),
    agentId: text("agent_id").notNull(),
    title: text("title").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("conversations_owner_idx").on(t.customerId, t.ownerPrincipalId, t.updatedAt)],
);

export interface StoredCitation {
  evidenceId: string;
  documentId: string;
  chunkId: string;
  title: string;
  version: string;
  indexedAt: string;
  location?: string;
  excerpt: string;
}

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    status: text("status"),
    citations: jsonb("citations").$type<StoredCitation[]>().notNull().default(sql`'[]'::jsonb`),
    model: jsonb("model").$type<{ provider: string; name: string }>(),
    runId: uuid("run_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id").notNull(),
    principalId: text("principal_id").notNull(),
    conversationId: uuid("conversation_id"),
    requestId: text("request_id").notNull(),
    agentId: text("agent_id").notNull(),
    agentVersion: text("agent_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    status: text("status").notNull(),
    toolCalls: integer("tool_calls").notNull().default(0),
    model: jsonb("model").$type<{ provider: string; name: string }>(),
    usage: jsonb("usage").$type<{ inputTokens?: number; outputTokens?: number }>(),
    error: text("error"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("agent_runs_principal_idx").on(t.customerId, t.principalId, t.startedAt)],
);

/** Every evidence ID issued to a principal; citations resolve only through this ledger. */
export const issuedEvidence = pgTable(
  "issued_evidence",
  {
    evidenceId: text("evidence_id").primaryKey(),
    customerId: text("customer_id").notNull(),
    principalId: text("principal_id").notNull(),
    runId: uuid("run_id"),
    requestId: text("request_id").notNull(),
    sourceId: text("source_id").notNull(),
    documentId: text("document_id").notNull(),
    version: text("version").notNull(),
    chunkId: text("chunk_id").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    sourceUrl: text("source_url"),
    indexedAt: ts("indexed_at").notNull(),
    excerpt: text("excerpt").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("issued_evidence_principal_idx").on(t.customerId, t.principalId)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id").notNull(),
    principalId: text("principal_id"),
    requestId: text("request_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    outcome: text("outcome").$type<"allowed" | "denied" | "error" | "ok">().notNull(),
    /** Metadata only: never credentials, prompts, message bodies or excerpts. */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_events_customer_idx").on(t.customerId, t.createdAt)],
);
