/**
 * MOCK TESTS ONLY. These verify the adapter's request shaping and fail-closed
 * behaviour against a stubbed fetch that mimics the v0.27.2 documented
 * responses. They do NOT prove the integration works against a running
 * RAGFlow service; see README "Real RAGFlow verification".
 */
import { describe, expect, it } from "vitest";
import { KnowledgeBackendError, RagflowKnowledgeAdapter, type CatalogDocument } from "../src/index.js";

const doc = (id: string, ragflowId?: string, ds = "ds1"): CatalogDocument => ({
  customerId: "c",
  documentId: id,
  sourceId: "s",
  version: "1",
  title: id,
  aclGroups: ["g"],
  aclRevision: 1,
  externalRef: ragflowId ? { ragflowDatasetId: ds, ragflowDocumentId: ragflowId } : {},
  indexedAt: new Date(),
  tombstoned: false,
});

function stub(responder: (url: string, body: unknown) => unknown) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(responder(url, body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("RagflowKnowledgeAdapter (mocked HTTP)", () => {
  it("sends only authorized RAGFlow document IDs and re-maps results", async () => {
    const { f, calls } = stub(() => ({
      code: 0,
      data: {
        chunks: [
          { id: "k1", content: "allowed text", document_id: "rf-a", similarity: 0.9 },
          { id: "k2", content: "SHOULD BE DROPPED", document_id: "rf-unknown", similarity: 0.95 },
        ],
        total: 2,
      },
    }));
    const a = new RagflowKnowledgeAdapter({ baseUrl: "http://ragflow:9380/", apiKey: "k", timeoutMs: 1000, datasetId: "ds1", fetch: f });
    const out = await a.search({ query: "q", limit: 5, documents: [doc("a", "rf-a"), doc("b", "rf-b"), doc("c", "rf-c", "other-ds")] });
    expect(calls[0]!.url).toBe("http://ragflow:9380/api/v1/retrieval");
    expect(calls[0]!.auth).toBe("Bearer k");
    expect(calls[0]!.body).toMatchObject({ question: "q", dataset_ids: ["ds1"], document_ids: ["rf-a", "rf-b"], page_size: 5 });
    expect(out).toEqual([{ documentId: "a", chunkId: "rf:k1", text: "allowed text", score: 0.9 }]);
  });

  it("never issues an unscoped retrieval when no authorized document is indexed", async () => {
    const { f, calls } = stub(() => ({ code: 0, data: { chunks: [] } }));
    const a = new RagflowKnowledgeAdapter({ baseUrl: "http://ragflow:9380", apiKey: "k", timeoutMs: 1000, datasetId: "ds1", fetch: f });
    expect(await a.search({ query: "q", limit: 5, documents: [doc("a")] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("normalizes backend errors and schema drift", async () => {
    const err = stub(() => ({ code: 102, message: "`dataset_ids` is required." }));
    const a = new RagflowKnowledgeAdapter({ baseUrl: "http://ragflow:9380", apiKey: "k", timeoutMs: 1000, datasetId: "ds1", fetch: err.f });
    await expect(a.search({ query: "q", limit: 5, documents: [doc("a", "rf-a")] })).rejects.toBeInstanceOf(KnowledgeBackendError);
    const drift = stub(() => ({ code: 0, data: { items: [] } }));
    const b = new RagflowKnowledgeAdapter({ baseUrl: "http://ragflow:9380", apiKey: "k", timeoutMs: 1000, datasetId: "ds1", fetch: drift.f });
    await expect(b.search({ query: "q", limit: 5, documents: [doc("a", "rf-a")] })).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
