import { sql } from "drizzle-orm";
import {
  bigserial,
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

export type StoredCitation =
  | {
      kind?: "document";
      evidenceId: string;
      documentId: string;
      chunkId: string;
      title: string;
      version: string;
      indexedAt: string;
      location?: string;
      excerpt: string;
    }
  | {
      kind: "live";
      evidenceId: string;
      connectorId: string;
      capabilityId: string;
      resourceId: string;
      title: string;
      readAt: string;
      excerpt: string;
    };

export interface StoredToolCall {
  capabilityId: string;
  kind: "read" | "write";
  status: "ok" | "denied" | "invalid" | "error" | "budget_exhausted";
  durationMs: number;
  resultCount?: number;
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
    toolCalls: jsonb("tool_calls").$type<StoredToolCall[]>().notNull().default(sql`'[]'::jsonb`),
    proposalIds: jsonb("proposal_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
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

/** One row per tool call attempted in a run. Arguments are stored only as a hash. */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    customerId: text("customer_id").notNull(),
    principalId: text("principal_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    capabilityVersion: text("capability_version").notNull(),
    kind: text("kind").$type<"read" | "write">().notNull(),
    status: text("status").notNull(),
    argsHash: text("args_hash"),
    errorKind: text("error_kind"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("tool_calls_run_idx").on(t.runId)],
);

/** Live reads issued as citable evidence (lv_ ids), bound to the principal. */
export const liveEvidence = pgTable(
  "live_evidence",
  {
    evidenceId: text("evidence_id").primaryKey(),
    customerId: text("customer_id").notNull(),
    principalId: text("principal_id").notNull(),
    runId: uuid("run_id").notNull(),
    connectorId: text("connector_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    resourceId: text("resource_id").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull(),
    readAt: ts("read_at").notNull(),
  },
  (t) => [index("live_evidence_principal_idx").on(t.customerId, t.principalId)],
);

export type ActionStateValue =
  | "pending_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "rejected"
  | "expired"
  | "cancelled";

/** Proposed external writes. Only the ActionService changes `state`, transactionally. */
export const actionProposals = pgTable(
  "action_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id").notNull(),
    principalId: text("principal_id").notNull(),
    conversationId: uuid("conversation_id"),
    runId: uuid("run_id"),
    capabilityId: text("capability_id").notNull(),
    capabilityVersion: text("capability_version").notNull(),
    connectorId: text("connector_id").notNull(),
    tool: text("tool").notNull(),
    operation: text("operation").notNull(),
    destination: text("destination").notNull(),
    risk: text("risk").notNull(),
    /** Complete connector arguments, including the idempotency key. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    policyVersion: text("policy_version").notNull(),
    state: text("state").$type<ActionStateValue>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    approvedBy: text("approved_by"),
    decidedAt: ts("decided_at"),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_proposals_idem_uq").on(t.idempotencyKey),
    index("action_proposals_owner_idx").on(t.customerId, t.principalId, t.createdAt),
  ],
);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  proposalId: uuid("proposal_id").notNull().references(() => actionProposals.id),
  customerId: text("customer_id").notNull(),
  approverPrincipalId: text("approver_principal_id").notNull(),
  decision: text("decision").$type<"approved" | "rejected">().notNull(),
  payloadHash: text("payload_hash").notNull(),
  policyVersion: text("policy_version").notNull(),
  requestId: text("request_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const executionAttempts = pgTable(
  "execution_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id").notNull().references(() => actionProposals.id),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome").$type<"succeeded" | "failed" | "unknown" | "reconciled" | "skipped">(),
    errorKind: text("error_kind"),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [uniqueIndex("execution_attempts_uq").on(t.proposalId, t.attempt)],
);

/** Transactional outbox: written in the same transaction as the state change it announces. */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    availableAt: ts("available_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("outbox_events_dedupe_uq").on(t.type, t.aggregateId), index("outbox_events_pending_idx").on(t.processedAt, t.availableAt)],
);
