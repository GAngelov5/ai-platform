import { z } from "zod";
import { ConfigurationError } from "./errors.js";
import { assertApprovedEndpoint, isLocalHostname } from "./egress.js";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");
const list = z
  .string()
  .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  CUSTOMER_ID: z.string().regex(/^[a-z0-9_-]{2,64}$/).default("cust_demo"),
  BRAND_NAME: z.string().min(1).max(80).default("Company Brain (synthetic demo)"),
  POLICY_VERSION: z.string().min(1).default("policy-2026-10-18.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:3000"),
  COOKIE_SECURE: bool.default(false),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(480),

  AUTH_MODE: z.enum(["dev", "oidc"]).default("dev"),
  DEV_AUTH_ENABLED: bool.default(false),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),

  KNOWLEDGE_PROVIDER: z.enum(["fixture", "ragflow", "lightrag"]).default("fixture"),
  FIXTURES_DIR: z.string().optional(),
  RAGFLOW_BASE_URL: z.string().url().optional(),
  RAGFLOW_API_KEY: z.string().optional(),
  RAGFLOW_DATASET_ID: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  RAGFLOW_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(15000),
  LIGHTRAG_PARTITIONS: z.string().optional(),
  LIGHTRAG_API_KEY: z.string().optional(),
  LIGHTRAG_QUERY_MODE: z.enum(["naive", "local", "global", "hybrid", "mix"]).default("mix"),
  LIGHTRAG_RANKING: z.enum(["lexical", "native"]).default("lexical"),
  LIGHTRAG_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),

  /** How evidence is scored: query-term overlap, or embedding similarity (ADR 0010). */
  EVIDENCE_SCORING: z.enum(["lexical", "semantic"]).default("lexical"),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(500).max(120000).default(15000),
  /** Cosine mapped to evidence score 0 and 1. Defaults (nomic-embed-text): cosine 0.60 → score 0.6, calibrated on the eval sets for no wrong refusals (ADR 0010). */
  SEMANTIC_SCORE_FLOOR: z.coerce.number().min(-1).max(1).default(0.15),
  SEMANTIC_SCORE_CEIL: z.coerce.number().min(-1).max(1).default(0.9),

  /** JSON list of knowledge sources (packages/knowledge SourcesConfigSchema); defaults to the synthetic sources. */
  KNOWLEDGE_SOURCES: z.string().optional(),
  INGEST_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
  /** Adds the synthetic evaluation corpus (fixtures/sources/eval-corpus) to the default sources. */
  KNOWLEDGE_INCLUDE_EVAL_CORPUS: bool.default(false),
  /** JSON allowlist of MCP servers with pinned tool hashes (see packages/connectors McpServersSchema). */
  MCP_SERVERS: z.string().optional(),
  LICENCE_FILE: z.string().min(1).optional(),
  // Personal Google connections (ADR 0015): calendar read-only, per user.
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  /** 32 random bytes, base64: seals stored connection tokens. */
  CONNECTION_ENCRYPTION_KEY: z.string().min(1).optional(),
  // Notion source (ADR 0015). The token itself is read by reference (NOTION_TOKEN), never stored.
  NOTION_TOKEN: z.string().min(1).optional(),
  /** Platform groups that may read every page shared with the Notion integration. */
  NOTION_ACL_GROUPS: z.string().default("all-staff"),
  ACTION_PROPOSAL_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),

  MODEL_MODE: z.enum(["local", "hybrid"]).default("local"),
  MODEL_PROVIDER: z.enum(["fake", "openai-compatible"]).default("fake"),
  MODEL_BASE_URL: z.string().url().optional(),
  MODEL_NAME: z.string().optional(),
  MODEL_API_KEY: z.string().optional(),
  MODEL_APPROVED_ENDPOINTS: list.default([]),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(900000).default(60000),
});

export interface PlatformConfig {
  env: "development" | "test" | "production";
  customerId: string;
  brandName: string;
  policyVersion: string;
  logLevel: string;
  /** Signed licence (ADR 0014); outside production the development licence is the default. */
  licenceFile?: string;
  databaseUrl?: string;
  redisUrl?: string;
  api: { port: number; publicOrigin: string; cookieSecure: boolean; sessionTtlMinutes: number };
  auth:
    | { mode: "dev"; devAuthEnabled: boolean }
    | { mode: "oidc"; devAuthEnabled: false; issuer: string; clientId: string; clientSecret: string };
  knowledge:
    | { provider: "fixture"; fixturesDir?: string }
    | { provider: "ragflow"; baseUrl: string; apiKey: string; datasetId: string; timeoutMs: number }
    | {
        provider: "lightrag";
        partitions: { id: string; url: string; sourceIds: string[]; aclGroups: string[] }[];
        apiKey: string;
        queryMode: "naive" | "local" | "global" | "hybrid" | "mix";
        ranking: "lexical" | "native";
        timeoutMs: number;
        fixturesDir?: string;
      };
  evidenceScoring:
    | { mode: "lexical" }
    | { mode: "semantic"; baseUrl: string; model: string; timeoutMs: number; floor: number; ceil: number };
  integrations: {
    mcpServersJson?: string;
    proposalTtlMinutes: number;
    /** Personal Google connections; absent when not configured. */
    google?: { clientId: string; clientSecret: string; redirectUri: string };
    connectionEncryptionKey?: string;
  };
  ingestion: {
    sourcesJson?: string;
    intervalMinutes: number;
    includeEvalCorpus: boolean;
    /** Adds the Notion source to the default sources when NOTION_TOKEN is set. */
    notion?: { aclGroups: string[] };
  };
  model:
    | { mode: "local" | "hybrid"; provider: "fake" }
    | {
        mode: "local" | "hybrid";
        provider: "openai-compatible";
        baseUrl: string;
        name: string;
        apiKey?: string;
        approvedEndpoints: string[];
        timeoutMs: number;
      };
}

const DEV_PASSWORD_MARKERS = ["platform_dev", "changeme", "password"];

/**
 * Validates environment configuration. Production startup rejects missing
 * secrets, development authentication, synthetic fixtures and the fake model.
 */
export function loadPlatformConfig(
  env: Record<string, string | undefined>,
  opts: { requireDatabase?: boolean; requireRedis?: boolean } = {},
): PlatformConfig {
  // Compose passes unset optional variables as empty strings; treat them as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const problems: string[] = [];
  const prod = e.APP_ENV === "production";

  if (prod && !e.LICENCE_FILE) problems.push("production requires LICENCE_FILE (a signed licence)");
  if (opts.requireDatabase && !e.DATABASE_URL) problems.push("DATABASE_URL is required");
  if (opts.requireRedis && !e.REDIS_URL) problems.push("REDIS_URL is required");

  // --- Authentication -------------------------------------------------------
  if (prod && e.AUTH_MODE !== "oidc") problems.push("production requires AUTH_MODE=oidc");
  if (prod && e.DEV_AUTH_ENABLED) problems.push("production must not set DEV_AUTH_ENABLED");
  if (e.AUTH_MODE === "oidc") {
    if (e.DEV_AUTH_ENABLED) problems.push("DEV_AUTH_ENABLED cannot be combined with AUTH_MODE=oidc");
    if (!e.OIDC_ISSUER) problems.push("OIDC_ISSUER is required when AUTH_MODE=oidc");
    if (!e.OIDC_CLIENT_ID) problems.push("OIDC_CLIENT_ID is required when AUTH_MODE=oidc");
    if (!e.OIDC_CLIENT_SECRET) problems.push("OIDC_CLIENT_SECRET is required when AUTH_MODE=oidc");
  }

  // --- Transport / secrets ----------------------------------------------------
  if (prod && !e.COOKIE_SECURE) problems.push("production requires COOKIE_SECURE=true");
  if (prod && !e.PUBLIC_ORIGIN.startsWith("https://")) problems.push("production requires an https PUBLIC_ORIGIN");
  if (prod && e.DATABASE_URL) {
    const pw = safePassword(e.DATABASE_URL);
    if (!pw || DEV_PASSWORD_MARKERS.some((m) => pw.includes(m))) {
      problems.push("production DATABASE_URL must contain a non-development password");
    }
  }

  // --- Knowledge -------------------------------------------------------------
  if (prod && e.KNOWLEDGE_INCLUDE_EVAL_CORPUS) problems.push("production must not include the synthetic evaluation corpus");
  if (prod && e.KNOWLEDGE_PROVIDER === "fixture") problems.push("production must not use the synthetic fixture knowledge provider");
  if (e.KNOWLEDGE_PROVIDER === "ragflow") {
    if (!e.RAGFLOW_BASE_URL) problems.push("RAGFLOW_BASE_URL is required when KNOWLEDGE_PROVIDER=ragflow");
    if (!e.RAGFLOW_API_KEY) problems.push("RAGFLOW_API_KEY is required when KNOWLEDGE_PROVIDER=ragflow");
    if (!e.RAGFLOW_DATASET_ID) problems.push("RAGFLOW_DATASET_ID is required when KNOWLEDGE_PROVIDER=ragflow");
    if (e.RAGFLOW_BASE_URL && !isLocalHostname(new URL(e.RAGFLOW_BASE_URL).hostname)) {
      problems.push("RAGFLOW_BASE_URL must point at the self-hosted RAG service on the private network");
    }
  }

  let lightragPartitions: { id: string; url: string; sourceIds: string[]; aclGroups: string[] }[] = [];
  if (e.KNOWLEDGE_PROVIDER === "lightrag") {
    if (!e.LIGHTRAG_API_KEY) problems.push("LIGHTRAG_API_KEY is required when KNOWLEDGE_PROVIDER=lightrag");
    if (prod && e.LIGHTRAG_API_KEY && e.LIGHTRAG_API_KEY.length < 24) problems.push("production LIGHTRAG_API_KEY must be at least 24 characters");
    if (!e.LIGHTRAG_PARTITIONS) problems.push("LIGHTRAG_PARTITIONS is required when KNOWLEDGE_PROVIDER=lightrag");
    else {
      const parsedParts = PartitionsSchema.safeParse(safeJson(e.LIGHTRAG_PARTITIONS));
      if (!parsedParts.success) {
        problems.push(`LIGHTRAG_PARTITIONS: ${parsedParts.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      } else {
        lightragPartitions = parsedParts.data;
        for (const p of lightragPartitions) {
          if (!isLocalHostname(new URL(p.url).hostname)) problems.push(`LIGHTRAG partition ${p.id} must point at the private network`);
        }
      }
    }
  }

  if (e.EVIDENCE_SCORING === "semantic") {
    if (!e.EMBEDDING_BASE_URL) problems.push("EMBEDDING_BASE_URL is required when EVIDENCE_SCORING=semantic");
    else if (!isLocalHostname(new URL(e.EMBEDDING_BASE_URL).hostname)) problems.push("EMBEDDING_BASE_URL must point at the private network");
    if (!(e.SEMANTIC_SCORE_CEIL > e.SEMANTIC_SCORE_FLOOR)) problems.push("SEMANTIC_SCORE_CEIL must be above SEMANTIC_SCORE_FLOOR");
  }

  // --- Model -------------------------------------------------------------------
  if (prod && e.MODEL_PROVIDER === "fake") problems.push("production must not use the fake model provider");
  if (e.MODEL_PROVIDER === "openai-compatible") {
    if (!e.MODEL_BASE_URL) problems.push("MODEL_BASE_URL is required when MODEL_PROVIDER=openai-compatible");
    if (!e.MODEL_NAME) problems.push("MODEL_NAME is required when MODEL_PROVIDER=openai-compatible");
    if (e.MODEL_BASE_URL) {
      try {
        assertApprovedEndpoint(e.MODEL_BASE_URL, e.MODEL_APPROVED_ENDPOINTS, e.MODEL_MODE, "MODEL_BASE_URL");
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    if (e.MODEL_MODE === "hybrid" && e.MODEL_BASE_URL && new URL(e.MODEL_BASE_URL).protocol !== "https:" &&
        !isLocalHostname(new URL(e.MODEL_BASE_URL).hostname)) {
      problems.push("hybrid mode requires https for non-local model endpoints");
    }
  }

  if (!!e.GOOGLE_OAUTH_CLIENT_ID !== !!e.GOOGLE_OAUTH_CLIENT_SECRET) problems.push("set both GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or neither");
  if (e.GOOGLE_OAUTH_CLIENT_ID && !e.CONNECTION_ENCRYPTION_KEY) problems.push("CONNECTION_ENCRYPTION_KEY is required for personal Google connections");
  if (e.CONNECTION_ENCRYPTION_KEY && Buffer.from(e.CONNECTION_ENCRYPTION_KEY, "base64").length !== 32) {
    problems.push("CONNECTION_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)");
  }
  const notionGroups = e.NOTION_ACL_GROUPS.split(",").map((g) => g.trim()).filter(Boolean);
  if (e.NOTION_TOKEN && notionGroups.length === 0) problems.push("NOTION_ACL_GROUPS must list at least one platform group");

  if (e.MCP_SERVERS) {
    const parsed = safeJson(e.MCP_SERVERS);
    if (!Array.isArray(parsed)) problems.push("MCP_SERVERS must be a JSON array");
    else {
      for (const srv of parsed as { id?: string; url?: string }[]) {
        const tokenVar = mcpTokenVar(String(srv?.id ?? ""));
        const token = env[tokenVar];
        if (!token) problems.push(`${tokenVar} is required for MCP server ${srv?.id}`);
        else if (prod && token.length < 24) problems.push(`production ${tokenVar} must be at least 24 characters`);
        try {
          if (!isLocalHostname(new URL(String(srv?.url)).hostname)) problems.push(`MCP server ${srv?.id} must be on the private network`);
        } catch {
          problems.push(`MCP server ${srv?.id} has an invalid url`);
        }
      }
    }
  }

  if (problems.length) throw new ConfigurationError(problems);

  return {
    env: e.APP_ENV,
    customerId: e.CUSTOMER_ID,
    brandName: e.BRAND_NAME,
    policyVersion: e.POLICY_VERSION,
    logLevel: e.LOG_LEVEL,
    licenceFile: e.LICENCE_FILE,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    api: {
      port: e.API_PORT,
      publicOrigin: new URL(e.PUBLIC_ORIGIN).origin,
      cookieSecure: e.COOKIE_SECURE,
      sessionTtlMinutes: e.SESSION_TTL_MINUTES,
    },
    auth:
      e.AUTH_MODE === "oidc"
        ? { mode: "oidc", devAuthEnabled: false, issuer: e.OIDC_ISSUER!, clientId: e.OIDC_CLIENT_ID!, clientSecret: e.OIDC_CLIENT_SECRET! }
        : { mode: "dev", devAuthEnabled: e.DEV_AUTH_ENABLED },
    knowledge:
      e.KNOWLEDGE_PROVIDER === "ragflow"
        ? { provider: "ragflow", baseUrl: e.RAGFLOW_BASE_URL!, apiKey: e.RAGFLOW_API_KEY!, datasetId: e.RAGFLOW_DATASET_ID!, timeoutMs: e.RAGFLOW_TIMEOUT_MS }
        : e.KNOWLEDGE_PROVIDER === "lightrag"
          ? {
              provider: "lightrag",
              partitions: lightragPartitions,
              apiKey: e.LIGHTRAG_API_KEY!,
              queryMode: e.LIGHTRAG_QUERY_MODE,
              ranking: e.LIGHTRAG_RANKING,
              timeoutMs: e.LIGHTRAG_TIMEOUT_MS,
              fixturesDir: e.FIXTURES_DIR,
            }
          : { provider: "fixture", fixturesDir: e.FIXTURES_DIR },
    evidenceScoring:
      e.EVIDENCE_SCORING === "semantic"
        ? {
            mode: "semantic",
            baseUrl: e.EMBEDDING_BASE_URL!,
            model: e.EMBEDDING_MODEL,
            timeoutMs: e.EMBEDDING_TIMEOUT_MS,
            floor: e.SEMANTIC_SCORE_FLOOR,
            ceil: e.SEMANTIC_SCORE_CEIL,
          }
        : { mode: "lexical" },
    integrations: {
      mcpServersJson: e.MCP_SERVERS,
      proposalTtlMinutes: e.ACTION_PROPOSAL_TTL_MINUTES,
      google: e.GOOGLE_OAUTH_CLIENT_ID
        ? { clientId: e.GOOGLE_OAUTH_CLIENT_ID, clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET!, redirectUri: `${new URL(e.PUBLIC_ORIGIN).origin}/api/connections/google/callback` }
        : undefined,
      connectionEncryptionKey: e.CONNECTION_ENCRYPTION_KEY,
    },
    ingestion: {
      sourcesJson: e.KNOWLEDGE_SOURCES,
      intervalMinutes: e.INGEST_INTERVAL_MINUTES,
      includeEvalCorpus: e.KNOWLEDGE_INCLUDE_EVAL_CORPUS,
      notion: e.NOTION_TOKEN ? { aclGroups: notionGroups } : undefined,
    },
    model:
      e.MODEL_PROVIDER === "openai-compatible"
        ? {
            mode: e.MODEL_MODE,
            provider: "openai-compatible",
            baseUrl: e.MODEL_BASE_URL!,
            name: e.MODEL_NAME!,
            apiKey: e.MODEL_API_KEY,
            approvedEndpoints: e.MODEL_APPROVED_ENDPOINTS,
            timeoutMs: e.MODEL_TIMEOUT_MS,
          }
        : { mode: e.MODEL_MODE, provider: "fake" },
  };
}

const PartitionsSchema = z
  .array(
    z
      .strictObject({
        id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
        url: z.string().url(),
        sourceId: z.string().min(1).optional(),
        sourceIds: z.array(z.string().min(1)).min(1).optional(),
        aclGroups: z.array(z.string().min(1)).min(1),
      })
      .refine((p) => !!p.sourceId !== !!p.sourceIds, "set exactly one of sourceId or sourceIds")
      .transform(({ sourceId, sourceIds, ...rest }) => ({ ...rest, sourceIds: sourceIds ?? [sourceId!] })),
  )
  .min(1)
  .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, "partition ids must be unique")
  .refine((ps) => {
    const keys = ps.flatMap((p) => p.sourceIds.map((s) => `${s}|${[...new Set(p.aclGroups)].sort().join(",")}`));
    return new Set(keys).size === keys.length;
  }, "two partitions must not accept the same source and ACL set");

/** Secret reference for an MCP server's audience-bound token, e.g. MCP_TOKEN_ATLAS_TRACKER. */
export const mcpTokenVar = (serverId: string) => `MCP_TOKEN_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

function safePassword(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return undefined;
  }
}
