import type { AdapterChunk, AdapterSearchRequest, CatalogDocument, KnowledgeAdapter } from "../types.js";
import { RagflowClient, type RagflowClientOptions } from "./client.js";

export const RAGFLOW_REF_DATASET = "ragflowDatasetId";
export const RAGFLOW_REF_DOCUMENT = "ragflowDocumentId";

/**
 * RAGFlow adapter. Document-level permission is enforced by sending only the
 * authorized documents' RAGFlow IDs as `document_ids` (backend prefilter),
 * then re-mapping every returned chunk back to an authorized catalog entry.
 */
export class RagflowKnowledgeAdapter implements KnowledgeAdapter {
  readonly name = "ragflow";
  private readonly client: RagflowClient;

  constructor(opts: RagflowClientOptions & { datasetId: string; similarityThreshold?: number }) {
    this.client = new RagflowClient(opts);
    this.datasetId = opts.datasetId;
    this.threshold = opts.similarityThreshold ?? 0.2;
  }
  private readonly datasetId: string;
  private readonly threshold: number;

  private refs(docs: readonly CatalogDocument[]) {
    const byRagflowId = new Map<string, CatalogDocument>();
    for (const d of docs) {
      const ds = d.externalRef[RAGFLOW_REF_DATASET];
      const id = d.externalRef[RAGFLOW_REF_DOCUMENT];
      if (ds === this.datasetId && id) byRagflowId.set(id, d);
    }
    return byRagflowId;
  }

  async search(req: AdapterSearchRequest): Promise<AdapterChunk[]> {
    const map = this.refs(req.documents);
    if (map.size === 0) return [];
    const data = await this.client.retrieval(
      {
        question: req.query,
        datasetIds: [this.datasetId],
        documentIds: [...map.keys()],
        pageSize: req.limit,
        similarityThreshold: this.threshold,
      },
      req.signal,
    );
    const out: AdapterChunk[] = [];
    for (const c of data.chunks) {
      const doc = map.get(c.document_id);
      if (!doc) continue; // outside the authorized prefilter: drop
      out.push({ documentId: doc.documentId, chunkId: `rf:${c.id}`, text: c.content, score: Math.max(0, Math.min(1, c.similarity)) });
    }
    return out;
  }

  async getDocumentChunks(doc: CatalogDocument, signal?: AbortSignal): Promise<AdapterChunk[]> {
    const id = doc.externalRef[RAGFLOW_REF_DOCUMENT];
    if (!id || doc.externalRef[RAGFLOW_REF_DATASET] !== this.datasetId) return [];
    const data = await this.client.listChunks(this.datasetId, id, signal);
    return data.chunks
      .filter((c) => c.document_id === id && c.available !== false)
      .map((c) => ({ documentId: doc.documentId, chunkId: `rf:${c.id}`, text: c.content, score: 1 }));
  }

  health() {
    return this.client.healthz();
  }
}
