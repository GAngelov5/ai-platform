import { z } from "zod";

/**
 * Runtime-validated contracts shared by the API, web client, agents and adapters.
 * Request schemas are strict: unknown keys (for example a client-supplied
 * principalId or customerId) are rejected rather than silently ignored.
 */

export const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:#-]+$/);

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export const EvidenceSchema = z.strictObject({
  /** Opaque, run-scoped identifier. The model may cite only IDs issued in its run. */
  evidenceId: z.string().regex(/^ev_[A-Za-z0-9_-]{8,64}$/),
  sourceId: IdSchema,
  documentId: IdSchema,
  version: z.string().min(1).max(100),
  chunkId: IdSchema,
  title: z.string().min(1).max(500),
  location: z.string().max(500).optional(),
  sourceUrl: z.string().max(2000).optional(),
  indexedAt: z.iso.datetime(),
  /** Only text the principal is authorized to read. */
  excerpt: z.string().max(4000),
  score: z.number().min(0),
  /** A newer version of this document exists and the principal can read it. */
  supersededBy: IdSchema.optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const DocumentChunkViewSchema = z.strictObject({
  chunkId: IdSchema,
  location: z.string().max(500).optional(),
  text: z.string(),
});
export type DocumentChunkView = z.infer<typeof DocumentChunkViewSchema>;

export const DocumentViewSchema = z.strictObject({
  documentId: IdSchema,
  sourceId: IdSchema,
  version: z.string(),
  title: z.string(),
  sourceUrl: z.string().optional(),
  indexedAt: z.iso.datetime(),
  chunks: z.array(DocumentChunkViewSchema),
});
export type DocumentView = z.infer<typeof DocumentViewSchema>;

export const KnowledgeSearchRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).default(5),
});
export type KnowledgeSearchRequest = z.infer<typeof KnowledgeSearchRequestSchema>;

export const KnowledgeSearchResponseSchema = z.strictObject({
  evidence: z.array(EvidenceSchema),
});
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponseSchema>;

export const EvidenceResolutionSchema = z.strictObject({
  evidence: EvidenceSchema.omit({ score: true }),
  documentPath: z.string(),
});
export type EvidenceResolution = z.infer<typeof EvidenceResolutionSchema>;

// ---------------------------------------------------------------------------
// Conversations and agent answers
// ---------------------------------------------------------------------------

export const DocumentCitationSchema = z.strictObject({
  kind: z.literal("document").optional(),
  evidenceId: EvidenceSchema.shape.evidenceId,
  documentId: IdSchema,
  chunkId: IdSchema,
  title: z.string(),
  version: z.string(),
  indexedAt: z.iso.datetime(),
  location: z.string().optional(),
  excerpt: z.string(),
});
export type DocumentCitation = z.infer<typeof DocumentCitationSchema>;

/** A value read from a live system during the run (current state, not indexed history). */
export const LiveCitationSchema = z.strictObject({
  kind: z.literal("live"),
  evidenceId: z.string().regex(/^lv_[A-Za-z0-9_-]{8,64}$/),
  connectorId: z.string(),
  capabilityId: z.string(),
  resourceId: z.string(),
  title: z.string(),
  readAt: z.iso.datetime(),
  excerpt: z.string(),
});
export type LiveCitation = z.infer<typeof LiveCitationSchema>;

export const CitationSchema = z.union([LiveCitationSchema, DocumentCitationSchema]);
export type Citation = z.infer<typeof CitationSchema>;
export const isLiveCitation = (c: Citation): c is LiveCitation => c.kind === "live";

export const AnswerStatusSchema = z.enum([
  "answered",
  "action_proposed",
  "insufficient_evidence",
  "limit_reached",
  "withheld",
  "error",
]);
export type AnswerStatus = z.infer<typeof AnswerStatusSchema>;

export const MessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  status: AnswerStatusSchema.optional(),
  citations: z.array(CitationSchema),
  model: z.strictObject({ provider: z.string(), name: z.string() }).optional(),
  toolCalls: z.array(z.lazy(() => ToolCallSummarySchema)).optional(),
  proposalIds: z.array(z.string()).optional(),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSummarySchema = z.strictObject({
  id: z.string(),
  agentId: IdSchema,
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationDetailSchema = ConversationSummarySchema.extend({
  messages: z.array(MessageSchema),
  /** An answer is still being produced (e.g. after a page reload); poll until false. */
  runInProgress: z.boolean(),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

export const CreateConversationRequestSchema = z.strictObject({
  agentId: IdSchema,
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const PostMessageRequestSchema = z.strictObject({
  content: z.string().trim().min(1).max(4000),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const PostMessageResponseSchema = z.strictObject({
  userMessage: MessageSchema,
  assistantMessage: MessageSchema,
});
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

// ---------------------------------------------------------------------------
// Identity, agents and health
// ---------------------------------------------------------------------------

export const DevLoginRequestSchema = z.strictObject({
  principalId: IdSchema,
});
export type DevLoginRequest = z.infer<typeof DevLoginRequestSchema>;

export const MeResponseSchema = z.strictObject({
  principalId: z.string(),
  displayName: z.string(),
  customerId: z.string(),
  authMode: z.enum(["dev", "oidc"]),
  /** e.g. "admin" shows the admin console. Authorization is always re-checked server-side. */
  roles: z.array(z.string()),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const DevPrincipalSchema = z.strictObject({
  principalId: z.string(),
  displayName: z.string(),
  description: z.string(),
});
export type DevPrincipal = z.infer<typeof DevPrincipalSchema>;

export const AgentSummarySchema = z.strictObject({
  id: IdSchema,
  version: z.string(),
  name: z.string(),
  description: z.string(),
  /** Display name and description per UI language, e.g. { bg: { name, description } }. */
  localized: z.record(z.string(), z.strictObject({ name: z.string(), description: z.string() })).optional(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const PublicConfigSchema = z.strictObject({
  brandName: z.string(),
  environment: z.string(),
  knowledgeProvider: z.string(),
  modelProvider: z.string(),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

export const ReadinessSchema = z.strictObject({
  status: z.enum(["ready", "not_ready"]),
  checks: z.record(z.string(), z.strictObject({ ok: z.boolean(), detail: z.string().optional() })),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

export const ApiErrorSchema = z.strictObject({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Tools, runs and actions
// ---------------------------------------------------------------------------

export const ToolCallSummarySchema = z.strictObject({
  capabilityId: z.string(),
  kind: z.enum(["read", "write"]),
  status: z.enum(["ok", "denied", "invalid", "error", "budget_exhausted"]),
  durationMs: z.number().int().min(0),
  resultCount: z.number().int().min(0).optional(),
});
export type ToolCallSummary = z.infer<typeof ToolCallSummarySchema>;

export const ActionStateSchema = z.enum([
  "pending_approval",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "unknown",
  "rejected",
  "expired",
  "cancelled",
]);
export type ActionState = z.infer<typeof ActionStateSchema>;

export const ActionProposalViewSchema = z.strictObject({
  id: z.string(),
  state: ActionStateSchema,
  capabilityId: z.string(),
  connectorId: z.string(),
  operation: z.string(),
  destination: z.string(),
  risk: z.string(),
  /** The complete intended operation as it will be executed. */
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string(),
  conversationId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  receipt: z.record(z.string(), z.unknown()).nullable(),
  lastError: z.string().nullable(),
});
export type ActionProposalView = z.infer<typeof ActionProposalViewSchema>;

export const ApproveActionRequestSchema = z.strictObject({
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApproveActionRequest = z.infer<typeof ApproveActionRequestSchema>;

// ---------------------------------------------------------------------------
// Workflows (ADR 0011)
// ---------------------------------------------------------------------------

export const WorkflowRunViewSchema = z.strictObject({
  id: z.string(),
  scheduledFor: z.iso.datetime(),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  attempts: z.number().int().min(0),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** Kind-specific summary, e.g. checked tasks, changes and proposal ids. */
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
});
export type WorkflowRunView = z.infer<typeof WorkflowRunViewSchema>;

export const WorkflowViewSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  config: z.record(z.string(), z.unknown()),
  intervalMinutes: z.number().int(),
  enabled: z.boolean(),
  nextRunAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  lastRun: WorkflowRunViewSchema.nullable(),
});
export type WorkflowView = z.infer<typeof WorkflowViewSchema>;

export const CreateWorkflowRequestSchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  config: z.record(z.string(), z.unknown()),
  /** 15 minutes to one week. */
  intervalMinutes: z.number().int().min(15).max(7 * 24 * 60),
});
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;

export const WorkflowKindViewSchema = z.strictObject({
  kind: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string(),
});
export type WorkflowKindView = z.infer<typeof WorkflowKindViewSchema>;

/** Server-sent run events (`text/event-stream`, one JSON object per `data:` line). */
export const RunEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run.started"), runId: z.string(), userMessage: z.lazy(() => MessageSchema) }),
  z.strictObject({ type: z.literal("tool.started"), capabilityId: z.string(), kind: z.enum(["read", "write"]) }),
  z.strictObject({ type: z.literal("tool.finished"), call: ToolCallSummarySchema }),
  z.strictObject({ type: z.literal("message"), assistantMessage: z.lazy(() => MessageSchema) }),
  z.strictObject({ type: z.literal("error"), message: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

export const CSRF_HEADER = "x-csrf-token";
export const CSRF_COOKIE = "platform_csrf";
export const SESSION_COOKIE = "platform_session";
