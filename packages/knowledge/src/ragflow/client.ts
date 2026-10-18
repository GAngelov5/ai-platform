import { z } from "zod";
import { KnowledgeBackendError } from "../types.js";

/**
 * Minimal typed client for the RAGFlow HTTP API, pinned to release v0.27.2.
 * Endpoints are taken from docs/references/http_api_reference.md at that tag:
 *   POST /api/v1/retrieval
 *   GET  /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks
 *   POST /api/v1/datasets/{dataset_id}/documents        (multipart upload)
 *   POST /api/v1/datasets/{dataset_id}/chunks           (parse documents)
 *   GET  /api/v1/datasets/{dataset_id}/documents?id=    (document status)
 *   GET  /api/v1/system/healthz
 * These have NOT been exercised against a running v0.27.2 service in this
 * milestone; see docs/adr/0003 and README "Real RAGFlow verification".
 */
export const RAGFLOW_PINNED_RELEASE = "v0.27.2";

const Envelope = z.object({ code: z.number(), message: z.string().optional(), data: z.unknown().optional() });

export const RetrievalChunk = z.object({
  id: z.string(),
  content: z.string(),
  document_id: z.string(),
  dataset_id: z.string().optional(),
  document_keyword: z.string().optional(),
  similarity: z.number(),
});
const RetrievalData = z.object({ chunks: z.array(RetrievalChunk), total: z.number().optional() });

const ListChunk = z.object({ id: z.string(), content: z.string(), document_id: z.string(), available: z.boolean().optional() });
const ListChunksData = z.object({ chunks: z.array(ListChunk) });

const UploadedDoc = z.object({ id: z.string(), name: z.string(), run: z.string().optional() });
const ListDocsData = z.object({ docs: z.array(z.object({ id: z.string(), name: z.string(), run: z.string(), progress: z.number().optional() })) });

export interface RagflowClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class RagflowClient {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly o: RagflowClientOptions) {
    // Base URL comes from validated deployment config only, never from model or user input.
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.f = o.fetch ?? fetch;
  }

  private async call<T extends z.ZodTypeAny>(
    method: "GET" | "POST",
    path: string,
    schema: T,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<z.infer<T>> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.o.apiKey}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, init);
    } catch (err) {
      const name = (err as Error).name;
      throw new KnowledgeBackendError(name === "TimeoutError" ? "timeout" : "unavailable", `RAGFlow request failed (${name})`);
    }
    if (res.status === 401 || res.status === 403) throw new KnowledgeBackendError("denied", `RAGFlow rejected credentials (${res.status})`);
    if (res.status === 429) throw new KnowledgeBackendError("throttled", "RAGFlow throttled the request");
    if (res.status >= 500) throw new KnowledgeBackendError("unavailable", `RAGFlow returned ${res.status}`);
    const json = Envelope.safeParse(await res.json().catch(() => null));
    if (!json.success) throw new KnowledgeBackendError("invalid_response", "RAGFlow response is not a valid envelope");
    if (json.data.code !== 0) {
      throw new KnowledgeBackendError("invalid_response", `RAGFlow error code ${json.data.code}`);
    }
    const data = schema.safeParse(json.data.data);
    if (!data.success) throw new KnowledgeBackendError("invalid_response", "RAGFlow response did not match the pinned schema");
    return data.data;
  }

  retrieval(
    req: { question: string; datasetIds: string[]; documentIds: string[]; pageSize: number; similarityThreshold: number },
    signal?: AbortSignal,
  ) {
    if (req.documentIds.length === 0) {
      // An empty document_ids list means "whole dataset" in RAGFlow; never send it.
      throw new KnowledgeBackendError("denied", "refusing unscoped RAGFlow retrieval");
    }
    return this.call(
      "POST",
      "/api/v1/retrieval",
      RetrievalData,
      {
        question: req.question,
        dataset_ids: req.datasetIds,
        document_ids: req.documentIds,
        page: 1,
        page_size: req.pageSize,
        similarity_threshold: req.similarityThreshold,
        vector_similarity_weight: 0.3,
        keyword: true,
        highlight: false,
      },
      signal,
    );
  }

  listChunks(datasetId: string, documentId: string, signal?: AbortSignal) {
    const p = `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks?page=1&page_size=200`;
    return this.call("GET", p, ListChunksData, undefined, signal);
  }

  uploadDocument(datasetId: string, fileName: string, content: string) {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/markdown" }), fileName);
    return this.call("POST", `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, z.array(UploadedDoc), form);
  }

  parseDocuments(datasetId: string, documentIds: string[]) {
    return this.call("POST", `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`, z.unknown(), { document_ids: documentIds });
  }

  getDocumentStatus(datasetId: string, documentId: string) {
    return this.call(
      "GET",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents?id=${encodeURIComponent(documentId)}`,
      ListDocsData,
    );
  }

  async healthz(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await this.f(`${this.base}/api/v1/system/healthz`, { signal: AbortSignal.timeout(3000), redirect: "error" });
      return { ok: res.ok, detail: `healthz ${res.status}` };
    } catch (err) {
      return { ok: false, detail: `unreachable (${(err as Error).name})` };
    }
  }
}
