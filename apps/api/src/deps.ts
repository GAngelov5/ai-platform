import { buildIntegrations, type ActionService } from "@platform/actions";
import { AgentRegistry, type CapabilityRegistry } from "@platform/agents";
import {
  GoogleCalendarProvider,
  NotionProvider,
  PersonalConnectionStore,
  type ConnectorRegistry,
  type GoogleEndpoints,
  type NotionOAuthEndpoints,
  type OAuthProvider,
} from "@platform/connectors";
import { AgentRuntime, FakeModelGateway, OpenAICompatibleGateway, type ModelGateway } from "@platform/ai";
import { knowledgeAssistant } from "@platform/agent-knowledge-assistant";
import { meetingPrep } from "@platform/agent-meeting-prep";
import { projectAssistant } from "@platform/agent-project-assistant";
import { createAdminQueries, createRepositories, type AdminQueries, type Database, type Repositories } from "@platform/database";
import {
  chunkText,
  LexicalKnowledgeAdapter,
  loadSources,
  type ChunkLoader,
  LightRagKnowledgeAdapter,
  OllamaEmbedder,
  PolicyEnforcingKnowledgeService,
  SemanticScoringAdapter,
  RagflowKnowledgeAdapter,
  type KnowledgeAdapter,
} from "@platform/knowledge";
import { loadEntitlements, mcpTokenVar, SecretSealer, type Entitlements, type PlatformConfig } from "@platform/security";
import { WorkflowService } from "@platform/workflows";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";

export const DEFAULT_FIXTURES_ROOT = fileURLToPath(new URL("../../../fixtures", import.meta.url));
/** The development licence: the default outside production (ADR 0014). */
export const DEFAULT_LICENCE_FILE = fileURLToPath(new URL("../../../fixtures/licence/dev.licence.json", import.meta.url));
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/documents", import.meta.url));

/** The configured knowledge sources (the same list the worker ingests). */
export const configuredSources = (config: PlatformConfig) =>
  loadSources(config.ingestion.sourcesJson, process.env.FIXTURES_ROOT ?? DEFAULT_FIXTURES_ROOT, { includeEvalCorpus: config.ingestion.includeEvalCorpus, notion: config.ingestion.notion });

/** Sources this deployment's application policy allows to be searched: every configured source. */
export const policySourceIds = (config: PlatformConfig) => configuredSources(config).map((s) => s.id);

export interface PlatformDeps {
  config: PlatformConfig;
  repos: Repositories;
  knowledge: PolicyEnforcingKnowledgeService;
  /** Every shipped agent; what a deployment may use is decided by `entitlements`. */
  agents: AgentRegistry;
  entitlements: Entitlements;
  runtime: AgentRuntime;
  model: ModelGateway;
  logger: Logger;
  pingDatabase: () => Promise<void>;
  actions: ActionService;
  capabilities: CapabilityRegistry;
  connectors: ConnectorRegistry;
  workflows: WorkflowService;
  admin: AdminQueries;
  /** "Connect" integrations (ADR 0015): the configured providers and the sealed token store. */
  connections: { providers: OAuthProvider[]; store?: PersonalConnectionStore };
}

/** Chunks of exactly the catalogued version, from the platform content store (ADR 0009). */
export function contentStoreChunks(repos: Repositories): ChunkLoader {
  return async (doc) => {
    const row = await repos.content.get(doc.customerId, doc.documentId);
    return row && row.version === doc.version ? chunkText(doc.documentId, row.text) : [];
  };
}

export async function createKnowledgeAdapter(config: PlatformConfig, repos: Repositories): Promise<KnowledgeAdapter> {
  const base = await createRetrievalAdapter(config, repos);
  const s = config.evidenceScoring;
  if (s.mode !== "semantic") return base;
  // Backend-independent semantic evidence score over the backend's candidates (ADR 0010).
  return new SemanticScoringAdapter(base, new OllamaEmbedder({ baseUrl: s.baseUrl, model: s.model, timeoutMs: s.timeoutMs }), { floor: s.floor, ceil: s.ceil });
}

async function createRetrievalAdapter(config: PlatformConfig, repos: Repositories): Promise<KnowledgeAdapter> {
  if (config.knowledge.provider === "ragflow") {
    const k = config.knowledge;
    return new RagflowKnowledgeAdapter({ baseUrl: k.baseUrl, apiKey: k.apiKey, datasetId: k.datasetId, timeoutMs: k.timeoutMs });
  }
  const chunks = contentStoreChunks(repos);
  if (config.knowledge.provider === "lightrag") {
    const k = config.knowledge;
    return new LightRagKnowledgeAdapter({
      partitions: k.partitions,
      apiKey: k.apiKey,
      timeoutMs: k.timeoutMs,
      queryMode: k.queryMode,
      ranking: k.ranking,
      // LightRAG has no "chunks of a document" endpoint: views come from the platform content store.
      documentContent: async (doc) => (await chunks(doc)).map((c) => ({ documentId: doc.documentId, chunkId: c.chunkId, text: c.text, location: c.location, score: 1 })),
    });
  }
  // Fixture provider: deterministic lexical retrieval over the content store (every ingested source).
  return new LexicalKnowledgeAdapter(chunks, "fixture");
}

export function createModelGateway(config: PlatformConfig): ModelGateway {
  const m = config.model;
  if (m.provider === "openai-compatible") {
    return new OpenAICompatibleGateway({
      baseUrl: m.baseUrl,
      modelName: m.name,
      apiKey: m.apiKey,
      mode: m.mode,
      approvedEndpoints: m.approvedEndpoints,
      timeoutMs: m.timeoutMs,
    });
  }
  return new FakeModelGateway();
}

export async function buildDeps(input: {
  config: PlatformConfig;
  db: Database;
  logger: Logger;
  pingDatabase: () => Promise<void>;
  adapter?: KnowledgeAdapter;
  model?: ModelGateway;
  /** Secret resolver; defaults to process.env. */
  secret?: (name: string) => string | undefined;
  entitlements?: Entitlements;
  /** Tests only: local fakes of Google's and Notion's endpoints. */
  googleEndpoints?: GoogleEndpoints;
  notionEndpoints?: NotionOAuthEndpoints;
}): Promise<PlatformDeps> {
  const { config, db, logger } = input;
  const repos = createRepositories(db);
  const adapter = input.adapter ?? (await createKnowledgeAdapter(config, repos));
  const knowledge = new PolicyEnforcingKnowledgeService({
    catalog: repos.catalog,
    principals: repos.principals,
    ledger: repos.evidence,
    adapter,
    policySourceIds: policySourceIds(config),
    onSecurityEvent: (e) => {
      logger.warn({ securityEvent: e.type, requestId: e.ctx.requestId, principalId: e.ctx.principalId, ...e.detail }, "security event");
      void repos.audit
        .write({ customerId: e.ctx.customerId, principalId: e.ctx.principalId, requestId: e.ctx.requestId, action: e.type, outcome: "denied", detail: e.detail })
        .catch(() => {});
    },
  });
  const model = input.model ?? createModelGateway(config);
  const entitlements = input.entitlements ?? loadEntitlements(config, DEFAULT_LICENCE_FILE);
  const agents = new AgentRegistry([projectAssistant, meetingPrep, knowledgeAssistant]);
  const securityEvent = (type: string, detail: Record<string, unknown>) => {
    logger.warn({ securityEvent: type, ...detail }, "security event");
    void repos.audit.write({ customerId: config.customerId, action: type, outcome: "denied", detail }).catch(() => {});
  };
  const g = config.integrations.google;
  const { actions, capabilities, connectors, google } = buildIntegrations({
    db,
    mcpServersJson: config.integrations.mcpServersJson,
    secret: input.secret ?? ((n) => process.env[n]),
    tokenVar: mcpTokenVar,
    principals: repos.principals,
    audit: repos.audit,
    proposalTtlMinutes: config.integrations.proposalTtlMinutes,
    onSecurityEvent: securityEvent,
    log: (msg, detail) => logger.info(detail ?? {}, msg),
    google: g
      ? { customerId: config.customerId, ...g, encryptionKey: config.integrations.connectionEncryptionKey!, rows: repos.connections, endpoints: input.googleEndpoints }
      : undefined,
  });
  const key = config.integrations.connectionEncryptionKey;
  const providers: OAuthProvider[] = [];
  if (google) providers.push(new GoogleCalendarProvider(google.oauth));
  if (config.integrations.notion) providers.push(new NotionProvider(config.integrations.notion, input.notionEndpoints));
  const connections = { providers, store: google?.store ?? (key ? new PersonalConnectionStore(repos.connections, new SecretSealer(key)) : undefined) };
  const runtime = new AgentRuntime({
    knowledge,
    model,
    runs: repos.runs,
    capabilities,
    toolCalls: repos.toolCalls,
    liveEvidence: repos.liveEvidence,
    actions,
  });
  // The API creates and lists workflows; the worker dispatches and executes them.
  const workflows = new WorkflowService({ db, capabilities, actions, principals: repos.principals, audit: repos.audit, policyVersion: config.policyVersion, entitlements });
  return { config, repos, knowledge, agents, entitlements, runtime, model, logger, pingDatabase: input.pingDatabase, actions, capabilities, connectors, workflows, admin: createAdminQueries(db), connections };
}
