import { z } from "zod";
import { KnowledgeBackendError } from "../types.js";

/**
 * Typed client for the LightRAG server API, pinned to release v1.5.7
 * (ghcr.io/hkuds/lightrag:v1.5.7). Endpoints and models come from
 * lightrag/api/routers/{document,query}_routes.py at that tag and were
 * exercised against a running v1.5.7 container:
 *   POST   /query/data                 retrieval only (no answer generation)
 *   POST   /documents/text             insert {text, file_source} -> track_id
 *   GET    /documents/track_status/:id processing status per document
 *   POST   /documents/paginated        list documents (id, file_path, status)
 *   DELETE /documents/delete_document  {doc_ids} -> background deletion
 *   GET    /documents/pipeline_status  busy flag
 *   GET    /health
 * Auth: X-API-Key header.
 */
export const LIGHTRAG_PINNED_RELEASE = "v1.5.7";

export const LightRagQueryModeSchema = z.enum(["naive", "local", "global", "hybrid", "mix"]);
export type LightRagQueryMode = z.infer<typeof LightRagQueryModeSchema>;

const QueryChunk = z.object({
  content: z.string(),
  file_path: z.string(),
  chunk_id: z.string(),
  reference_id: z.string().optional(),
});
const QueryDataResponse = z.object({
  status: z.string(),
  message: z.string().optional(),
  data: z.object({ chunks: z.array(QueryChunk).default([]) }).passthrough(),
});

const DocStatus = z.enum(["pending", "parsing", "analyzing", "processing", "preprocessed", "processed", "failed"]);
const DocItem = z.object({
  id: z.string(),
  status: DocStatus,
  file_path: z.string(),
  error_msg: z.string().nullable().optional(),
  chunks_count: z.number().nullable().optional(),
});
export type LightRagDocument = z.infer<typeof DocItem>;

const InsertResponse = z.object({ status: z.enum(["success", "partial_success", "failure"]), message: z.string(), track_id: z.string() });
const TrackStatus = z.object({ track_id: z.string(), documents: z.array(DocItem), total_count: z.number() });
const Paginated = z.object({
  documents: z.array(DocItem),
  pagination: z.object({ page: z.number(), total_pages: z.number() }).passthrough(),
});
const DeleteResponse = z.object({ status: z.enum(["deletion_started", "busy", "not_allowed"]), message: z.string(), doc_id: z.string() });
const PipelineStatus = z.object({ busy: z.boolean() }).passthrough();

export interface LightRagClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class LightRagClient {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly o: LightRagClientOptions) {
    // Partition URLs come from validated deployment config only.
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.f = o.fetch ?? fetch;
  }

  private async call<T extends z.ZodTypeAny>(method: "GET" | "POST" | "DELETE", path: string, schema: T, body?: unknown, signal?: AbortSignal): Promise<z.infer<T>> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { "X-API-Key": this.o.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "error",
      });
    } catch (err) {
      const name = (err as Error).name;
      throw new KnowledgeBackendError(name === "TimeoutError" ? "timeout" : "unavailable", `LightRAG request failed (${name})`);
    }
    if (res.status === 401 || res.status === 403) throw new KnowledgeBackendError("denied", `LightRAG rejected credentials (${res.status})`);
    if (res.status === 409 || res.status === 429) throw new KnowledgeBackendError("throttled", `LightRAG busy (${res.status})`);
    if (res.status >= 500) throw new KnowledgeBackendError("unavailable", `LightRAG returned ${res.status}`);
    if (res.status >= 400) throw new KnowledgeBackendError("invalid_response", `LightRAG rejected the request (${res.status})`);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new KnowledgeBackendError("invalid_response", "LightRAG response did not match the pinned schema");
    return parsed.data;
  }

  async queryChunks(query: string, opts: { mode: LightRagQueryMode; chunkTopK: number; topK: number }, signal?: AbortSignal) {
    const r = await this.call(
      "POST",
      "/query/data",
      QueryDataResponse,
      { query, mode: opts.mode, top_k: opts.topK, chunk_top_k: opts.chunkTopK, include_references: true },
      signal,
    );
    if (r.status !== "success") throw new KnowledgeBackendError("invalid_response", "LightRAG query did not succeed");
    return r.data.chunks;
  }

  insertText(text: string, fileSource: string) {
    return this.call("POST", "/documents/text", InsertResponse, { text, file_source: fileSource });
  }

  trackStatus(trackId: string) {
    return this.call("GET", `/documents/track_status/${encodeURIComponent(trackId)}`, TrackStatus);
  }

  async listDocuments(): Promise<LightRagDocument[]> {
    const all: LightRagDocument[] = [];
    for (let page = 1; ; page++) {
      const r = await this.call("POST", "/documents/paginated", Paginated, { page, page_size: 100, sort_field: "id", sort_direction: "asc" });
      all.push(...r.documents);
      if (page >= r.pagination.total_pages) return all;
    }
  }

  deleteDocuments(docIds: string[]) {
    return this.call("DELETE", "/documents/delete_document", DeleteResponse, { doc_ids: docIds, delete_file: true, delete_llm_cache: true });
  }

  pipelineStatus() {
    return this.call("GET", "/documents/pipeline_status", PipelineStatus);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await this.f(`${this.base}/health`, { signal: AbortSignal.timeout(3000), redirect: "error" });
      return { ok: res.ok, detail: `health ${res.status}` };
    } catch (err) {
      return { ok: false, detail: `unreachable (${(err as Error).name})` };
    }
  }
}
