import { AgentRegistry } from "@platform/agents";
import { AgentRuntime, FakeModelGateway, OpenAICompatibleGateway, type ModelGateway } from "@platform/ai";
import { projectAssistant } from "@platform/agent-project-assistant";
import { createRepositories, type Database, type Repositories } from "@platform/database";
import {
  FixtureKnowledgeAdapter,
  loadFixtureCorpus,
  PolicyEnforcingKnowledgeService,
  RagflowKnowledgeAdapter,
  type KnowledgeAdapter,
} from "@platform/knowledge";
import type { PlatformConfig } from "@platform/security";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";

/** Sources this deployment's application policy allows to be searched. */
export const POLICY_SOURCE_IDS = ["atlas-project-docs", "company-handbook"] as const;

export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/documents", import.meta.url));

export interface PlatformDeps {
  config: PlatformConfig;
  repos: Repositories;
  knowledge: PolicyEnforcingKnowledgeService;
  agents: AgentRegistry;
  runtime: AgentRuntime;
  model: ModelGateway;
  logger: Logger;
  pingDatabase: () => Promise<void>;
}

export async function createKnowledgeAdapter(config: PlatformConfig): Promise<KnowledgeAdapter> {
  if (config.knowledge.provider === "ragflow") {
    const k = config.knowledge;
    return new RagflowKnowledgeAdapter({ baseUrl: k.baseUrl, apiKey: k.apiKey, datasetId: k.datasetId, timeoutMs: k.timeoutMs });
  }
  return new FixtureKnowledgeAdapter(await loadFixtureCorpus(config.knowledge.fixturesDir ?? DEFAULT_FIXTURES_DIR));
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
}): Promise<PlatformDeps> {
  const { config, db, logger } = input;
  const repos = createRepositories(db);
  const adapter = input.adapter ?? (await createKnowledgeAdapter(config));
  const knowledge = new PolicyEnforcingKnowledgeService({
    catalog: repos.catalog,
    principals: repos.principals,
    ledger: repos.evidence,
    adapter,
    policySourceIds: POLICY_SOURCE_IDS,
    onSecurityEvent: (e) => {
      logger.warn({ securityEvent: e.type, requestId: e.ctx.requestId, principalId: e.ctx.principalId, ...e.detail }, "security event");
      void repos.audit
        .write({ customerId: e.ctx.customerId, principalId: e.ctx.principalId, requestId: e.ctx.requestId, action: e.type, outcome: "denied", detail: e.detail })
        .catch(() => {});
    },
  });
  const model = input.model ?? createModelGateway(config);
  const agents = new AgentRegistry([projectAssistant]);
  const runtime = new AgentRuntime({ knowledge, model, runs: repos.runs });
  return { config, repos, knowledge, agents, runtime, model, logger, pingDatabase: input.pingDatabase };
}
