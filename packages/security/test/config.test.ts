import { describe, expect, it } from "vitest";
import { ConfigurationError, loadPlatformConfig } from "../src/index.js";

const prodBase = {
  APP_ENV: "production",
  AUTH_MODE: "oidc",
  OIDC_ISSUER: "https://login.example.test/tenant/v2.0",
  OIDC_CLIENT_ID: "client",
  OIDC_CLIENT_SECRET: "s3cr3t-value",
  COOKIE_SECURE: "true",
  PUBLIC_ORIGIN: "https://brain.example.test",
  DATABASE_URL: "postgres://app:Str0ng-Generated-Pw@postgres:5432/platform",
  KNOWLEDGE_PROVIDER: "ragflow",
  RAGFLOW_BASE_URL: "http://ragflow:9380",
  RAGFLOW_API_KEY: "ragflow-key",
  RAGFLOW_DATASET_ID: "ds1",
  MODEL_PROVIDER: "openai-compatible",
  MODEL_MODE: "local",
  MODEL_BASE_URL: "http://vllm:8000/v1",
  MODEL_NAME: "local-model",
  MODEL_APPROVED_ENDPOINTS: "http://vllm:8000",
  LICENCE_FILE: "/etc/platform/customer.licence.json",
};

const problems = (env: Record<string, string>) => {
  try {
    loadPlatformConfig(env, { requireDatabase: true });
    return [];
  } catch (e) {
    if (e instanceof ConfigurationError) return e.problems;
    throw e;
  }
};

describe("platform configuration", () => {
  it("accepts a complete production configuration", () => {
    expect(problems(prodBase)).toEqual([]);
  });

  it("requires a signed licence file in production", () => {
    const { LICENCE_FILE: _, ...env } = prodBase;
    expect(problems(env)).toContain("production requires LICENCE_FILE (a signed licence)");
  });

  it("rejects development authentication in production", () => {
    const p = problems({ ...prodBase, AUTH_MODE: "dev", DEV_AUTH_ENABLED: "true" });
    expect(p).toContain("production requires AUTH_MODE=oidc");
    expect(p).toContain("production must not set DEV_AUTH_ENABLED");
  });

  it("rejects missing secrets, fixtures, fake model and insecure cookies in production", () => {
    const p = problems({
      ...prodBase,
      OIDC_CLIENT_SECRET: "",
      DATABASE_URL: "postgres://platform:platform_dev@postgres:5432/platform",
      KNOWLEDGE_PROVIDER: "fixture",
      MODEL_PROVIDER: "fake",
      COOKIE_SECURE: "false",
    });
    expect(p).toEqual(
      expect.arrayContaining([
        "OIDC_CLIENT_SECRET is required when AUTH_MODE=oidc",
        "production DATABASE_URL must contain a non-development password",
        "production must not use the synthetic fixture knowledge provider",
        "production must not use the fake model provider",
        "production requires COOKIE_SECURE=true",
      ]),
    );
  });

  it("refuses unapproved and non-local model endpoints", () => {
    expect(problems({ ...prodBase, MODEL_APPROVED_ENDPOINTS: "" }).join()).toMatch(/not in the approved endpoint list/);
    const hosted = { MODEL_BASE_URL: "https://api.example.com/v1", MODEL_APPROVED_ENDPOINTS: "https://api.example.com" };
    expect(problems({ ...prodBase, ...hosted }).join()).toMatch(/local model mode forbids non-local endpoint/);
    expect(problems({ ...prodBase, ...hosted, MODEL_MODE: "hybrid" })).toEqual([]);
  });

  it("validates LightRAG partitions", () => {
    const lr = { KNOWLEDGE_PROVIDER: "lightrag", LIGHTRAG_API_KEY: "k", DATABASE_URL: "postgres://u:p@db/x" };
    const part = (o: object) => JSON.stringify([{ id: "p_a", url: "http://lightrag-a:9621", sourceId: "s", aclGroups: ["g"], ...o }]);
    expect(problems({ ...lr, LIGHTRAG_PARTITIONS: part({}) })).toEqual([]);
    expect(problems({ ...lr, LIGHTRAG_PARTITIONS: part({ url: "https://lightrag.example.com" }) }).join()).toMatch(/private network/);
    expect(problems({ ...lr, LIGHTRAG_PARTITIONS: "not json" }).join()).toMatch(/LIGHTRAG_PARTITIONS/);
    const dup = JSON.stringify([
      { id: "p_a", url: "http://a:9621", sourceId: "s", aclGroups: ["g", "h"] },
      { id: "p_b", url: "http://b:9621", sourceId: "s", aclGroups: ["h", "g"] },
    ]);
    expect(problems({ ...lr, LIGHTRAG_PARTITIONS: dup }).join()).toMatch(/same source and ACL/);
    const multi = JSON.stringify([{ id: "p_a", url: "http://a:9621", sourceIds: ["s", "t"], aclGroups: ["g"] }]);
    expect(problems({ ...lr, LIGHTRAG_PARTITIONS: multi })).toEqual([]);
  });

  it("validates semantic evidence scoring", () => {
    const base = { DATABASE_URL: "postgres://u:p@db/x", EVIDENCE_SCORING: "semantic" };
    expect(problems(base).join()).toMatch(/EMBEDDING_BASE_URL is required/);
    expect(problems({ ...base, EMBEDDING_BASE_URL: "https://embeddings.example.com" }).join()).toMatch(/private network/);
    expect(problems({ ...base, EMBEDDING_BASE_URL: "http://ollama:11434", SEMANTIC_SCORE_FLOOR: "0.6", SEMANTIC_SCORE_CEIL: "0.5" }).join()).toMatch(/CEIL must be above/);
    const c = loadPlatformConfig({ ...base, EMBEDDING_BASE_URL: "http://ollama:11434" });
    expect(c.evidenceScoring).toMatchObject({ mode: "semantic", model: "nomic-embed-text", baseUrl: "http://ollama:11434" });
    expect(loadPlatformConfig({}).evidenceScoring).toEqual({ mode: "lexical" });
  });

  it("treats empty optional values as unset", () => {
    expect(() => loadPlatformConfig({ OIDC_ISSUER: "", RAGFLOW_BASE_URL: "", MODEL_BASE_URL: " " })).not.toThrow();
  });

  it("refuses a public sign-in provider (Google) unless it says who may sign in", () => {
    const google = { ...prodBase, OIDC_ISSUER: "https://accounts.google.com" };
    expect(problems(google).join()).toMatch(/OIDC_ALLOWED_DOMAINS or OIDC_ALLOWED_EMAILS/);
    expect(problems({ ...google, OIDC_ALLOWED_DOMAINS: "company.example" })).toEqual([]);
    expect(problems({ ...google, OIDC_ALLOWED_EMAILS: "tester@gmail.example" })).toEqual([]);
    expect(problems({ ...google, OIDC_ALLOWED_DOMAINS: "company.example", OIDC_DEFAULT_GROUPS: "All Staff" }).join()).toMatch(/not a platform group name/);
    const auth = loadPlatformConfig({ ...google, OIDC_ALLOWED_DOMAINS: "@Company.Example", OIDC_ALLOWED_EMAILS: "Tester@Gmail.example", OIDC_DEFAULT_GROUPS: "all-staff" }).auth;
    expect(auth).toMatchObject({ allowedDomains: ["company.example"], allowedEmails: ["tester@gmail.example"], defaultGroups: ["all-staff"] });
  });

  it("defaults to synthetic, offline development settings", () => {
    const c = loadPlatformConfig({});
    expect(c.env).toBe("development");
    expect(c.knowledge.provider).toBe("fixture");
    expect(c.model.provider).toBe("fake");
    expect(c.auth).toEqual({ mode: "dev", devAuthEnabled: false });
  });
});
