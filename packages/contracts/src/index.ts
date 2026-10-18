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

export const CitationSchema = z.strictObject({
  evidenceId: EvidenceSchema.shape.evidenceId,
  documentId: IdSchema,
  chunkId: IdSchema,
  title: z.string(),
  version: z.string(),
  indexedAt: z.iso.datetime(),
  location: z.string().optional(),
  excerpt: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const AnswerStatusSchema = z.enum([
  "answered",
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

export const CSRF_HEADER = "x-csrf-token";
export const CSRF_COOKIE = "platform_csrf";
export const SESSION_COOKIE = "platform_session";
