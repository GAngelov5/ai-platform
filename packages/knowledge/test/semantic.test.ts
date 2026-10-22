/**
 * MOCK TESTS for the semantic evidence score: a fake embedder and a fake
 * Ollama HTTP API. Real embeddings are exercised by scripts/eval-retrieval.mjs.
 */
import { describe, expect, it } from "vitest";
import { cosine, KnowledgeBackendError, OllamaEmbedder, SemanticScoringAdapter, type AdapterChunk, type Embedder, type KnowledgeAdapter } from "../src/index.js";

const chunk = (id: string, text: string, score = 0.5): AdapterChunk => ({ documentId: id, chunkId: `${id}#0`, text, score });

/** Vectors by keyword: "travel" → [1,0], "leave" → [0,1]; the query is embedded the same way. */
const fakeEmbedder = (): Embedder & { calls: string[][] } => {
  const calls: string[][] = [];
  const vec = (t: string) => (t.includes("travel") || t.includes("trip") ? [1, 0.1] : t.includes("leave") ? [0, 1] : [0.5, 0.5]);
  return { model: "fake", calls, embed: async (texts) => (calls.push([...texts]), texts.map(vec)), health: async () => ({ ok: true }) };
};

const inner = (chunks: AdapterChunk[], seen: number[] = []): KnowledgeAdapter => ({
  name: "inner",
  search: async (req) => (seen.push(req.limit), chunks.slice(0, req.limit)),
  getDocumentChunks: async () => [],
  health: async () => ({ ok: true }),
});

describe("SemanticScoringAdapter", () => {
  it("re-ranks the inner adapter's candidates by embedding similarity and maps cosine to the score", async () => {
    const limits: number[] = [];
    const a = new SemanticScoringAdapter(
      inner([chunk("leave", "annual leave days", 0.9), chunk("travel", "travel per diem", 0.2), chunk("misc", "canteen menu", 0.8)], limits),
      fakeEmbedder(),
      { floor: 0.2, ceil: 0.9 },
    );
    const out = await a.search({ query: "money for a work trip", limit: 2, documents: [] });
    expect(limits).toEqual([6]); // asks for 3x candidates
    expect(out.map((c) => c.documentId)).toEqual(["travel", "misc"]);
    expect(out[0]!.score).toBe(1); // cosine ≈ 1 ≥ ceil
    expect(out[1]!.score).toBeCloseTo((cosine([1, 0.1], [0.5, 0.5]) - 0.2) / 0.7, 5);
    expect(a.name).toBe("inner+semantic");
  });

  it("returns nothing without candidates, and never embeds", async () => {
    const e = fakeEmbedder();
    expect(await new SemanticScoringAdapter(inner([]), e, { floor: 0, ceil: 1 }).search({ query: "x", limit: 5, documents: [] })).toEqual([]);
    expect(e.calls).toEqual([]);
  });

  it("fails closed when embeddings are unavailable", async () => {
    const broken: Embedder = { model: "x", embed: async () => Promise.reject(new KnowledgeBackendError("unavailable", "down")), health: async () => ({ ok: false }) };
    const a = new SemanticScoringAdapter(inner([chunk("a", "text")]), broken, { floor: 0, ceil: 1 });
    await expect(a.search({ query: "q", limit: 5, documents: [] })).rejects.toBeInstanceOf(KnowledgeBackendError);
    expect((await a.health()).ok).toBe(false);
  });

  it("rejects a ceil that is not above the floor", () => {
    expect(() => new SemanticScoringAdapter(inner([]), fakeEmbedder(), { floor: 0.5, ceil: 0.5 })).toThrow();
  });
});

describe("OllamaEmbedder (mocked HTTP)", () => {
  function fakeOllama(reply: (input: string[]) => unknown = (input) => ({ embeddings: input.map((t) => [t.length, 1]) }), status = 200) {
    const requests: { url: string; body: { model: string; input: string[] } }[] = [];
    const f = (async (url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), body });
      return new Response(JSON.stringify(reply(body.input)), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { f, requests };
  }

  it("adds nomic task prefixes and caches document embeddings, never queries", async () => {
    const { f, requests } = fakeOllama();
    const e = new OllamaEmbedder({ baseUrl: "http://ollama:11434", model: "nomic-embed-text", timeoutMs: 1000, fetch: f });
    await e.embed(["what is the per diem"], "query");
    await e.embed(["travel policy", "leave policy"], "document");
    await e.embed(["leave policy", "travel policy", "new doc"], "document");
    await e.embed(["what is the per diem"], "query");
    expect(requests.map((r) => r.body.input)).toEqual([
      ["search_query: what is the per diem"],
      ["search_document: travel policy", "search_document: leave policy"],
      ["search_document: new doc"],
      ["search_query: what is the per diem"],
    ]);
    expect(requests[0]!.url).toBe("http://ollama:11434/api/embed");
    expect(requests[0]!.body.model).toBe("nomic-embed-text");
  });

  it("returns vectors in input order, including duplicates and cache hits", async () => {
    const { f } = fakeOllama();
    const e = new OllamaEmbedder({ baseUrl: "http://ollama:11434", model: "other-model", timeoutMs: 1000, fetch: f });
    expect(await e.embed(["aa", "bbbb", "aa"], "document")).toEqual([[2, 1], [4, 1], [2, 1]]); // no prefix for other models
  });

  it("maps HTTP errors and malformed replies to backend errors", async () => {
    const down = new OllamaEmbedder({ baseUrl: "http://ollama:11434", model: "m", timeoutMs: 1000, fetch: fakeOllama(() => ({}), 500).f });
    await expect(down.embed(["x"], "query")).rejects.toMatchObject({ kind: "unavailable" });
    const bad = new OllamaEmbedder({ baseUrl: "http://ollama:11434", model: "m", timeoutMs: 1000, fetch: fakeOllama(() => ({ embeddings: [["nope"]] })).f });
    await expect(bad.embed(["x"], "query")).rejects.toMatchObject({ kind: "invalid_response" });
    expect((await down.health()).ok).toBe(false);
  });
});
