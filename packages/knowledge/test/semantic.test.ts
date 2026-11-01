/**
 * MOCK TESTS for the semantic evidence score: a fake embedder and a fake
 * Ollama HTTP API. Real embeddings are exercised by scripts/eval-retrieval.mjs.
 */
import { describe, expect, it } from "vitest";
import {
  cosine,
  EMBEDDING_FORMAT,
  embedMissingDocuments,
  KnowledgeBackendError,
  OllamaEmbedder,
  OpenAICompatibleEmbedder,
  SemanticScoringAdapter,
  type AdapterChunk,
  type CatalogDocument,
  type Embedder,
  type KnowledgeAdapter,
  type PassageIndex,
} from "../src/index.js";

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

describe("SemanticScoringAdapter, hybrid", () => {
  const doc = (id: string, title = id): CatalogDocument => ({ customerId: "c", documentId: id, sourceId: "s", version: "1", title, aclGroups: [], aclRevision: 1, externalRef: {}, indexedAt: new Date(0), tombstoned: false });
  const store: Record<string, AdapterChunk[]> = {
    travel: [chunk("travel", "per diem rates for trips", 1)],
    leave: [chunk("leave", "annual leave days", 1)],
    secret: [chunk("secret", "travel budget of the board", 1)],
  };
  /** Word overlap finds nothing for the question below; only the authorized documents' chunks are reachable. */
  const lexicalNone = (loaded: string[]): KnowledgeAdapter => ({
    name: "lexical",
    search: async () => [],
    getDocumentChunks: async (d) => (loaded.push(d.documentId), store[d.documentId] ?? []),
    health: async () => ({ ok: true }),
  });

  it("finds a document that shares no words with the question, among the authorized documents only", async () => {
    const loaded: string[] = [];
    const a = new SemanticScoringAdapter(lexicalNone(loaded), fakeEmbedder(), { floor: 0.2, ceil: 0.9, dense: true });
    const out = await a.search({ query: "money for a work trip", limit: 1, documents: [doc("travel"), doc("leave")] });
    expect(out.map((c) => c.documentId)).toEqual(["travel"]);
    expect(loaded.sort()).toEqual(["leave", "travel"]); // "secret" is never loaded: not in the request's documents
  });

  it("embeds each chunk with its document title, and blends in the word-overlap score", async () => {
    const e = fakeEmbedder();
    const inner: KnowledgeAdapter = {
      name: "lexical",
      // Same embedding for both; only word overlap separates them.
      search: async () => [chunk("june", "status report", 1)],
      getDocumentChunks: async (d) => [chunk(d.documentId, "status report", 1)],
      health: async () => ({ ok: true }),
    };
    const a = new SemanticScoringAdapter(inner, e, { floor: 0, ceil: 1, dense: true, lexicalWeight: 0.2 });
    const out = await a.search({ query: "status", limit: 2, documents: [doc("july", "Status July"), doc("june", "Status June")] });
    expect(out.map((c) => c.documentId)).toEqual(["june", "july"]);
    const sem = cosine([0.5, 0.5], [0.5, 0.5]);
    expect(out[0]!.score).toBeCloseTo(0.8 * sem + 0.2, 5);
    expect(out[1]!.score).toBeCloseTo(0.8 * sem, 5); // a chunk found only by embeddings gets no word-overlap share
    expect(e.calls.flat()).toContain("Status June\nstatus report");
  });
});

describe("SemanticScoringAdapter, hybrid over stored embeddings", () => {
  const doc = (id: string, version = "1"): CatalogDocument => ({ customerId: "c", documentId: id, sourceId: "s", version, title: id, aclGroups: [], aclRevision: 1, externalRef: {}, indexedAt: new Date(0), tombstoned: false });
  const store: Record<string, AdapterChunk[]> = {
    travel: [chunk("travel", "per diem rates for trips", 1)],
    leave: [chunk("leave", "annual leave days", 1)],
  };
  /** In-memory PassageIndex that records which documents it was asked about. */
  function memoryIndex() {
    const rows = new Map<string, { documentId: string; version: string; chunkId: string; model: string; format: string; embedding: readonly number[] }>();
    const asked: string[][] = [];
    const index: PassageIndex = {
      covered: async (_c, model, format, docs) =>
        new Set(docs.filter((d) => [...rows.values()].some((r) => r.documentId === d.documentId && r.version === d.version && r.model === model && r.format === format)).map((d) => d.documentId)),
      replaceDocument: async (_c, documentId, version, model, format, chunks) => {
        for (const [k, r] of rows) if (r.documentId === documentId && r.model === model) rows.delete(k);
        for (const ch of chunks) rows.set(ch.chunkId, { documentId, version, chunkId: ch.chunkId, model, format, embedding: ch.embedding });
      },
      nearest: async (_c, model, format, q, docs, limit, include = []) => {
        asked.push(docs.map((d) => d.documentId));
        const ok = (r: { documentId: string; version: string; model: string; format: string }) => r.model === model && r.format === format && docs.some((d) => d.documentId === r.documentId && d.version === r.version);
        const all = [...rows.values()].filter(ok).map((r) => ({ documentId: r.documentId, chunkId: r.chunkId, cosine: cosine(q, r.embedding) }));
        const top = [...all].sort((a, b) => b.cosine - a.cosine).slice(0, limit);
        return [...top, ...all.filter((r) => include.includes(r.chunkId) && !top.includes(r))];
      },
    };
    return { index, rows, asked };
  }
  const lexicalNone: KnowledgeAdapter = { name: "lexical", search: async () => [], getDocumentChunks: async (d) => store[d.documentId] ?? [], health: async () => ({ ok: true }) };

  it("embeds each authorized document once, then searches the stored embeddings", async () => {
    const e = fakeEmbedder();
    const { index, rows, asked } = memoryIndex();
    const a = new SemanticScoringAdapter(lexicalNone, e, { floor: 0.2, ceil: 0.9, dense: true, index });
    const docs = [doc("travel"), doc("leave")];
    const out = await a.search({ query: "money for a work trip", limit: 1, documents: docs });
    expect(out.map((c) => [c.documentId, c.text])).toEqual([["travel", "per diem rates for trips"]]);
    expect([...rows.values()].map((r) => r.format)).toEqual([EMBEDDING_FORMAT, EMBEDDING_FORMAT]);
    const documentEmbeds = e.calls.length;
    await a.search({ query: "money for a work trip", limit: 1, documents: docs });
    expect(e.calls.length).toBe(documentEmbeds + 1); // only the query: passages come from the index
    expect(asked.every((ids) => ids.sort().join() === "leave,travel")).toBe(true); // never anything but the authorized documents
  });

  it("re-embeds a document whose version changed, and caps embedding during one search", async () => {
    const e = fakeEmbedder();
    const { index } = memoryIndex();
    const chunks = async (d: CatalogDocument) => store[d.documentId] ?? [];
    expect(await embedMissingDocuments([doc("travel"), doc("leave")], { index, embedder: e, chunks, max: 1 })).toBe(1);
    expect(await embedMissingDocuments([doc("travel"), doc("leave")], { index, embedder: e, chunks })).toBe(1);
    expect(await embedMissingDocuments([doc("travel"), doc("leave")], { index, embedder: e, chunks })).toBe(0);
    expect(await embedMissingDocuments([doc("travel", "2"), doc("leave")], { index, embedder: e, chunks })).toBe(1);
  });
});

describe("OpenAICompatibleEmbedder (mocked HTTP)", () => {
  function fakeApi(status = 200) {
    const requests: { url: string; auth: string | null; body: { model: string; input: string[] } }[] = [];
    const f: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init!.body)) as { model: string; input: string[] };
      requests.push({ url: String(url), auth: new Headers(init!.headers).get("authorization"), body });
      // Out of order on purpose: the client must order by index.
      const data = body.input.map((t, index) => ({ index, embedding: [t.length, 1] })).reverse();
      return new Response(JSON.stringify({ data }), { status });
    };
    return { f, requests };
  }

  it("posts to {base}/embeddings in batches with the key, orders by index, and caches documents", async () => {
    const { f, requests } = fakeApi();
    const e = new OpenAICompatibleEmbedder({ baseUrl: "https://api.example.test/v1/", model: "m", apiKey: "k", timeoutMs: 1000, fetch: f, batchSize: 2 });
    expect(await e.embed(["a", "bbb", "cc"], "document")).toEqual([[1, 1], [3, 1], [2, 1]]);
    expect(requests.map((r) => r.body.input)).toEqual([["a", "bbb"], ["cc"]]);
    expect(requests[0]).toMatchObject({ url: "https://api.example.test/v1/embeddings", auth: "Bearer k", body: { model: "m" } });
    await e.embed(["a", "cc"], "document");
    expect(requests).toHaveLength(2); // cached
    await e.embed(["a"], "query");
    expect(requests).toHaveLength(3); // queries are never cached
  });

  it("fails closed on errors and unexpected shapes", async () => {
    const e = new OpenAICompatibleEmbedder({ baseUrl: "https://x.test/v1", model: "m", timeoutMs: 1000, fetch: fakeApi(500).f });
    await expect(e.embed(["a"], "query")).rejects.toBeInstanceOf(KnowledgeBackendError);
    const bad = new OpenAICompatibleEmbedder({ baseUrl: "https://x.test/v1", model: "m", timeoutMs: 1000, fetch: async () => new Response(JSON.stringify({ data: [] })) });
    await expect(bad.embed(["a"], "query")).rejects.toMatchObject({ kind: "invalid_response" });
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
