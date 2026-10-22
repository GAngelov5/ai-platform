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

export interface SemanticScoringOptions {
  /** Cosine similarity mapped to score 0 (and below). */
  floor: number;
  /** Cosine similarity mapped to score 1 (and above). */
  ceil: number;
  /** How many candidates to ask the inner adapter for, as a multiple of the limit. */
  candidateFactor?: number;
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
    const candidates = await this.inner.search({ ...req, limit: Math.min(req.limit * (this.o.candidateFactor ?? 3), 30) });
    if (candidates.length === 0) return [];
    const [q] = await this.embedder.embed([req.query], "query", req.signal);
    const docs = await this.embedder.embed(candidates.map((c) => c.text), "document", req.signal);
    return candidates
      .map((c, i) => ({ ...c, score: this.score(cosine(q!, docs[i]!)) }))
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, req.limit);
  }

  getDocumentChunks(doc: CatalogDocument, signal?: AbortSignal) {
    return this.inner.getDocumentChunks(doc, signal);
  }

  async health() {
    const [a, b] = await Promise.all([this.inner.health(), this.embedder.health()]);
    return { ok: a.ok && b.ok, detail: [a.detail, b.detail].filter(Boolean).join("; ") };
  }
}
