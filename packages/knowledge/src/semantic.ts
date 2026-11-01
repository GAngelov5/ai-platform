import { createHash } from "node:crypto";
import { KnowledgeBackendError, type AdapterChunk, type AdapterSearchRequest, type CatalogDocument, type KnowledgeAdapter } from "./types.js";

/** Turns text into vectors. Queries and documents may be embedded differently (asymmetric models). */
export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[], kind: "query" | "document", signal?: AbortSignal): Promise<number[][]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export interface OllamaEmbedderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Cached document embeddings (by model + text hash). Queries are never cached. */
  cacheSize?: number;
}

/**
 * Embeddings from a local Ollama server (`POST /api/embed`). nomic-embed-text
 * is asymmetric and expects task prefixes; other models get the text as is.
 */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  private readonly cache = new Map<string, number[]>();
  private readonly f: typeof fetch;

  constructor(private readonly o: OllamaEmbedderOptions) {
    this.model = o.model;
    this.f = o.fetch ?? fetch;
  }

  private prefix(kind: "query" | "document") {
    if (!this.model.startsWith("nomic-embed-text")) return "";
    return kind === "query" ? "search_query: " : "search_document: ";
  }

  private async call(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    let res: Response;
    try {
      res = await this.f(new URL("/api/embed", this.o.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input, truncate: true }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      const kind = (err as Error).name === "TimeoutError" ? "timeout" : "unavailable";
      throw new KnowledgeBackendError(kind, `embedding request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new KnowledgeBackendError("unavailable", `embedding service returned ${res.status}`);
    const body = (await res.json()) as { embeddings?: unknown };
    const out = body.embeddings;
    if (!Array.isArray(out) || out.length !== input.length || !out.every((v) => Array.isArray(v) && v.every((x) => typeof x === "number"))) {
      throw new KnowledgeBackendError("invalid_response", "embedding service returned an unexpected shape");
    }
    return out as number[][];
  }

  async embed(texts: readonly string[], kind: "query" | "document", signal?: AbortSignal): Promise<number[][]> {
    const p = this.prefix(kind);
    if (kind === "query") return this.call(texts.map((t) => p + t), signal);
    const keys = texts.map((t) => createHash("sha256").update(`${this.model}\u0000${t}`).digest("hex"));
    const missing = [...new Set(keys.filter((k) => !this.cache.has(k)))];
    if (missing.length) {
      const textOf = new Map(keys.map((k, i) => [k, texts[i]!]));
      const vectors = await this.call(missing.map((k) => p + textOf.get(k)!), signal);
      const max = this.o.cacheSize ?? 5000;
      missing.forEach((k, i) => {
        if (this.cache.size >= max) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(k, vectors[i]!);
      });
    }
    return keys.map((k) => this.cache.get(k)!);
  }

  async health() {
    try {
      await this.call(["health"]);
      return { ok: true, detail: `embeddings ${this.model}` };
    } catch (err) {
      return { ok: false, detail: `embeddings: ${(err as Error).message}` };
    }
  }
}

export interface OpenAICompatibleEmbedderOptions {
  /** Base URL including the API version, e.g. https://generativelanguage.googleapis.com/v1beta/openai or http://vllm:8000/v1. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  cacheSize?: number;
  /** Texts per request; providers cap batch sizes (Gemini: 100). */
  batchSize?: number;
}

/**
 * Embeddings from any OpenAI-compatible `POST {base}/embeddings` (vLLM, TEI,
 * Ollama's /v1, Gemini's OpenAI endpoint). Whether the endpoint may receive
 * document text is decided by configuration (private network, or an approved
 * endpoint in hybrid mode), never here.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  private readonly cache = new Map<string, number[]>();
  private readonly f: typeof fetch;

  constructor(private readonly o: OpenAICompatibleEmbedderOptions) {
    this.model = o.model;
    this.f = o.fetch ?? fetch;
  }

  private async call(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    const size = this.o.batchSize ?? 100;
    for (let i = 0; i < input.length; i += size) {
      const batch = input.slice(i, i + size);
      const timeout = AbortSignal.timeout(this.o.timeoutMs);
      let res: Response;
      try {
        res = await this.f(`${this.o.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
          body: JSON.stringify({ model: this.model, input: batch }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        const kind = (err as Error).name === "TimeoutError" ? "timeout" : "unavailable";
        throw new KnowledgeBackendError(kind, `embedding request failed: ${(err as Error).message}`);
      }
      if (!res.ok) throw new KnowledgeBackendError(res.status === 429 ? "unavailable" : "unavailable", `embedding service returned ${res.status}`);
      const body = (await res.json()) as { data?: { index?: number; embedding?: unknown }[] };
      const data = body.data;
      if (!Array.isArray(data) || data.length !== batch.length || !data.every((d) => Array.isArray(d.embedding) && (d.embedding as unknown[]).every((x) => typeof x === "number"))) {
        throw new KnowledgeBackendError("invalid_response", "embedding service returned an unexpected shape");
      }
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      out.push(...ordered.map((d) => d.embedding as number[]));
    }
    return out;
  }

  async embed(texts: readonly string[], kind: "query" | "document", signal?: AbortSignal): Promise<number[][]> {
    if (kind === "query") return this.call([...texts], signal);
    const keys = texts.map((t) => createHash("sha256").update(`${this.model}\u0000${t}`).digest("hex"));
    const missing = [...new Set(keys.filter((k) => !this.cache.has(k)))];
    if (missing.length) {
      const textOf = new Map(keys.map((k, i) => [k, texts[i]!]));
      const vectors = await this.call(missing.map((k) => textOf.get(k)!), signal);
      const max = this.o.cacheSize ?? 20_000;
      missing.forEach((k, i) => {
        if (this.cache.size >= max) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(k, vectors[i]!);
      });
    }
    return keys.map((k) => this.cache.get(k)!);
  }

  async health() {
    try {
      await this.call(["health"]);
      return { ok: true, detail: `embeddings ${this.model}` };
    } catch (err) {
      return { ok: false, detail: `embeddings: ${(err as Error).message}` };
    }
  }
}

/** The configured embedder (ADR 0010/0017). Shared by the API (search) and the worker (embedding new documents). */
export function createEmbedder(o: { provider: "ollama" | "openai-compatible"; baseUrl: string; apiKey?: string; model: string; timeoutMs: number }): Embedder {
  return o.provider === "openai-compatible"
    ? new OpenAICompatibleEmbedder({ baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model, timeoutMs: o.timeoutMs })
    : new OllamaEmbedder({ baseUrl: o.baseUrl, model: o.model, timeoutMs: o.timeoutMs });
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Stored passage embeddings (ADR 0017; pgvector in the platform database).
 * Every read is limited to the document versions passed in, which the caller
 * has authorized.
 */
export interface PassageIndex {
  covered(customerId: string, model: string, format: string, docs: readonly { documentId: string; version: string }[]): Promise<Set<string>>;
  replaceDocument(
    customerId: string,
    documentId: string,
    version: string,
    model: string,
    format: string,
    chunks: readonly { chunkId: string; embedding: readonly number[] }[],
  ): Promise<void>;
  nearest(
    customerId: string,
    model: string,
    format: string,
    query: readonly number[],
    docs: readonly { documentId: string; version: string }[],
    limit: number,
    include?: readonly string[],
  ): Promise<{ documentId: string; chunkId: string; cosine: number }[]>;
}

/** What a passage embedding is made of. Bump when it changes: stored embeddings of another format are re-made. */
export const EMBEDDING_FORMAT = "title-section-text/1";

/** The text embedded for a passage: the title and section carry what the passage often doesn't repeat. */
export const embeddingText = (title: string | undefined, c: { location?: string; text: string }) => [title, c.location, c.text].filter(Boolean).join("\n");

/**
 * Embeds and stores the passages of documents that have none yet for this model
 * and format (new documents, new versions, or a new embedding model). Used by the
 * worker after ingestion, and by search for anything the worker hasn't reached yet.
 * Returns how many documents were embedded.
 */
export async function embedMissingDocuments(
  docs: readonly CatalogDocument[],
  deps: { index: PassageIndex; embedder: Embedder; chunks: (doc: CatalogDocument, signal?: AbortSignal) => Promise<AdapterChunk[]>; max?: number; signal?: AbortSignal },
): Promise<number> {
  if (docs.length === 0) return 0;
  const byCustomer = new Map<string, CatalogDocument[]>();
  for (const d of docs) byCustomer.set(d.customerId, [...(byCustomer.get(d.customerId) ?? []), d]);
  let done = 0;
  for (const [customerId, list] of byCustomer) {
    const covered = await deps.index.covered(customerId, deps.embedder.model, EMBEDDING_FORMAT, list);
    for (const doc of list) {
      if (covered.has(doc.documentId)) continue;
      if (deps.max !== undefined && done >= deps.max) return done;
      const chunks = await deps.chunks(doc, deps.signal);
      const vectors = chunks.length ? await deps.embedder.embed(chunks.map((c) => embeddingText(doc.title, c)), "document", deps.signal) : [];
      await deps.index.replaceDocument(customerId, doc.documentId, doc.version, deps.embedder.model, EMBEDDING_FORMAT, chunks.map((c, i) => ({ chunkId: c.chunkId, embedding: vectors[i]! })));
      done++;
    }
  }
  return done;
}

export interface SemanticScoringOptions {
  /** Cosine similarity mapped to score 0 (and below). */
  floor: number;
  /** Cosine similarity mapped to score 1 (and above). */
  ceil: number;
  /** How many candidates to ask the inner adapter for, as a multiple of the limit. */
  candidateFactor?: number;
  /**
   * Hybrid retrieval: besides the inner adapter's candidates, every chunk of the
   * authorized documents is a candidate by embedding similarity. Finds documents
   * that share no words with the question ("analytics platform" for Borealis).
   * Embeddings are computed once per chunk text and cached.
   */
  dense?: boolean;
  /**
   * Hybrid only: share of the inner adapter's (lexical) score in the final score. Embeddings
   * barely tell "June" from "July"; word overlap does. Measured on the eval corpus: 0.2.
   */
  lexicalWeight?: number;
  /**
   * Hybrid only: stored embeddings. Without it, every authorized chunk is embedded in
   * memory (fine for tests and small corpora; lost on restart).
   */
  index?: PassageIndex;
  /** With an index: at most this many documents are embedded during one search (the worker does the rest). */
  maxEmbedPerSearch?: number;
}

/**
 * Backend-independent semantic evidence score (ADR 0010). The inner adapter
 * proposes candidates from the authorized documents only; this re-ranks them
 * by embedding similarity to the query and maps cosine linearly from
 * [floor, ceil] to the [0, 1] evidence score that the agent's threshold uses.
 * Fails closed: if embeddings are unavailable, search fails like a backend outage.
 */
export class SemanticScoringAdapter implements KnowledgeAdapter {
  readonly name: string;

  constructor(
    private readonly inner: KnowledgeAdapter,
    private readonly embedder: Embedder,
    private readonly o: SemanticScoringOptions,
  ) {
    if (!(o.ceil > o.floor)) throw new Error("semantic score ceil must be above floor");
    this.name = `${inner.name}+semantic`;
  }

  score(cos: number): number {
    return Math.max(0, Math.min(1, (cos - this.o.floor) / (this.o.ceil - this.o.floor)));
  }

  async search(req: AdapterSearchRequest): Promise<AdapterChunk[]> {
    if (!this.o.dense) {
      const candidates = await this.inner.search({ ...req, limit: Math.min(req.limit * (this.o.candidateFactor ?? 3), 30) });
      if (candidates.length === 0) return [];
      const [q] = await this.embedder.embed([req.query], "query", req.signal);
      const docs = await this.embedder.embed(candidates.map((c) => c.text), "document", req.signal);
      return candidates
        .map((c, i) => ({ ...c, score: this.score(cosine(q!, docs[i]!)) }))
        .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
        .slice(0, req.limit);
    }
    if (this.o.index) return this.searchIndexed(req, this.o.index);
    // Hybrid: the inner adapter's matches with their word-overlap score, plus every other authorized chunk at 0.
    const lexical = await this.inner.search({ ...req, limit: 100 });
    const lexScore = new Map(lexical.map((c) => [c.chunkId, c.score]));
    const candidates = await this.withDense(lexical, req);
    if (candidates.length === 0) return [];
    const [q] = await this.embedder.embed([req.query], "query", req.signal);
    // The title carries what a chunk often doesn't repeat: the project, the month, the kind of document.
    const titles = new Map(req.documents.map((d) => [d.documentId, d.title]));
    const docs = await this.embedder.embed(
      candidates.map((c) => embeddingText(titles.get(c.documentId), c)),
      "document",
      req.signal,
    );
    const w = this.o.lexicalWeight ?? 0.2;
    return candidates
      .map((c, i) => ({ ...c, score: (1 - w) * this.score(cosine(q!, docs[i]!)) + w * Math.max(0, Math.min(1, lexScore.get(c.chunkId) ?? 0)) }))
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, req.limit);
  }

  /**
   * Hybrid over stored embeddings: word matches from the inner adapter, plus the
   * nearest passages from the index. Both come only from `req.documents`.
   */
  private async searchIndexed(req: AdapterSearchRequest, index: PassageIndex): Promise<AdapterChunk[]> {
    if (req.documents.length === 0) return [];
    const customerId = req.documents[0]!.customerId;
    await embedMissingDocuments(req.documents, {
      index,
      embedder: this.embedder,
      chunks: (d, s) => this.inner.getDocumentChunks(d, s),
      max: this.o.maxEmbedPerSearch ?? 25,
      signal: req.signal,
    });
    const lexical = await this.inner.search({ ...req, limit: 100 });
    const [q] = await this.embedder.embed([req.query], "query", req.signal);
    const near = await index.nearest(customerId, this.embedder.model, EMBEDDING_FORMAT, q!, req.documents, Math.max(req.limit * 5, 30), lexical.map((c) => c.chunkId));
    const cos = new Map(near.map((n) => [n.chunkId, n.cosine]));

    // Text for passages found only by the index: read from the content store, as for the document view.
    const byId = new Map(lexical.map((c) => [c.chunkId, c]));
    const docsById = new Map(req.documents.map((d) => [d.documentId, d]));
    for (const documentId of new Set(near.filter((n) => !byId.has(n.chunkId)).map((n) => n.documentId))) {
      const doc = docsById.get(documentId);
      if (!doc) continue;
      for (const c of await this.inner.getDocumentChunks(doc, req.signal)) if (cos.has(c.chunkId) && !byId.has(c.chunkId)) byId.set(c.chunkId, { ...c, score: 0 });
    }

    // A word match in a document not embedded yet (more than maxEmbedPerSearch new ones): embed it here.
    const unscored = [...byId.values()].filter((c) => !cos.has(c.chunkId));
    if (unscored.length) {
      const v = await this.embedder.embed(unscored.map((c) => embeddingText(docsById.get(c.documentId)?.title, c)), "document", req.signal);
      unscored.forEach((c, i) => cos.set(c.chunkId, cosine(q!, v[i]!)));
    }
    const lexScore = new Map(lexical.map((c) => [c.chunkId, c.score]));
    const w = this.o.lexicalWeight ?? 0.2;
    return [...byId.values()]
      .map((c) => ({ ...c, score: (1 - w) * this.score(cos.get(c.chunkId) ?? 0) + w * Math.max(0, Math.min(1, lexScore.get(c.chunkId) ?? 0)) }))
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, req.limit);
  }

  /** Union of the inner candidates and every chunk of the authorized documents (only those: `req.documents` is the policy prefilter). */
  private async withDense(lexical: AdapterChunk[], req: AdapterSearchRequest): Promise<AdapterChunk[]> {
    const seen = new Set(lexical.map((c) => c.chunkId));
    const all: AdapterChunk[] = [...lexical];
    for (const doc of req.documents) {
      for (const c of await this.inner.getDocumentChunks(doc, req.signal)) {
        if (seen.has(c.chunkId)) continue;
        seen.add(c.chunkId);
        all.push(c);
      }
    }
    return all;
  }

  getDocumentChunks(doc: CatalogDocument, signal?: AbortSignal) {
    return this.inner.getDocumentChunks(doc, signal);
  }

  async health() {
    const [a, b] = await Promise.all([this.inner.health(), this.embedder.health()]);
    return { ok: a.ok && b.ok, detail: [a.detail, b.detail].filter(Boolean).join("; ") };
  }
}
