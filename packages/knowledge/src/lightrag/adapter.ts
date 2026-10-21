import type { AdapterChunk, AdapterSearchRequest, CatalogDocument, KnowledgeAdapter } from "../types.js";
import { terms } from "../text.js";
import { LightRagClient, type LightRagQueryMode } from "./client.js";
import {
  fileSourceFor,
  LIGHTRAG_REF_FILE_SOURCE,
  LIGHTRAG_REF_PARTITION,
  partitionFor,
  type LightRagPartition,
} from "./partitions.js";

export interface LightRagAdapterOptions {
  partitions: readonly LightRagPartition[];
  apiKey: string;
  timeoutMs: number;
  queryMode: LightRagQueryMode;
  /**
   * Source text for the protected document view. LightRAG v1.5.7 has no
   * "chunks of a document" endpoint, so the view is served from the
   * platform's ingestion copy of the (already authorized) document.
   */
  documentContent: (doc: CatalogDocument) => Promise<AdapterChunk[]>;
  fetch?: typeof fetch;
}

/**
 * LightRAG adapter with partition-level prefiltering.
 *
 * A partition is queried only if at least one authorized document is
 * currently indexed there AND that document's current source+ACL still map to
 * that partition. Only verbatim chunks are consumed (never LightRAG's
 * LLM-written entity/relation summaries), and each chunk must map back to an
 * authorized catalog document via its version-specific file_source.
 *
 * LightRAG returns no relevance score, so the score is the fraction of query
 * terms present in the chunk (same scale as the fixture adapter); the agent's
 * minEvidenceScore gate therefore behaves consistently across adapters.
 */
export class LightRagKnowledgeAdapter implements KnowledgeAdapter {
  readonly name = "lightrag";
  private readonly clients: Map<string, LightRagClient>;

  constructor(private readonly o: LightRagAdapterOptions) {
    this.clients = new Map(
      o.partitions.map((p) => [p.id, new LightRagClient({ baseUrl: p.url, apiKey: o.apiKey, timeoutMs: o.timeoutMs, fetch: o.fetch })]),
    );
  }

  /** Groups authorized, correctly-indexed documents by partition. */
  private routable(docs: readonly CatalogDocument[]) {
    const byPartition = new Map<string, Map<string, CatalogDocument>>();
    for (const d of docs) {
      const pid = d.externalRef[LIGHTRAG_REF_PARTITION];
      const fileSource = d.externalRef[LIGHTRAG_REF_FILE_SOURCE];
      const expected = partitionFor(d, this.o.partitions);
      // Stale placement (ACL/source changed since sync) or wrong version: not searchable until re-synced.
      if (!pid || !expected || expected.id !== pid || fileSource !== fileSourceFor(d)) continue;
      if (!byPartition.has(pid)) byPartition.set(pid, new Map());
      byPartition.get(pid)!.set(fileSource, d);
    }
    return byPartition;
  }

  async search(req: AdapterSearchRequest): Promise<AdapterChunk[]> {
    const routes = this.routable(req.documents);
    if (routes.size === 0) return [];
    const q = [...new Set(terms(req.query))];
    const perPartition = await Promise.all(
      [...routes].map(async ([pid, byFile]) => {
        const chunks = await this.clients.get(pid)!.queryChunks(
          req.query,
          { mode: this.o.queryMode, chunkTopK: Math.max(req.limit, 5), topK: 20 },
          req.signal,
        );
        const out: AdapterChunk[] = [];
        for (const c of chunks) {
          const doc = byFile.get(c.file_path.split("/").pop() ?? "");
          if (!doc || !c.content.trim()) continue; // not an authorized, current document: drop
          const t = new Set(terms(`${doc.title} ${c.content}`));
          const score = q.length ? q.filter((x) => t.has(x)).length / q.length : 0;
          out.push({ documentId: doc.documentId, chunkId: `lr:${pid}:${c.chunk_id}`.slice(0, 200), text: c.content, score });
        }
        return out;
      }),
    );
    return perPartition
      .flat()
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, req.limit);
  }

  getDocumentChunks(doc: CatalogDocument): Promise<AdapterChunk[]> {
    return this.o.documentContent(doc);
  }

  async health() {
    const results = await Promise.all([...this.clients].map(async ([id, c]) => [id, await c.health()] as const));
    const bad = results.filter(([, h]) => !h.ok).map(([id]) => id);
    return { ok: bad.length === 0, detail: bad.length ? `unhealthy partitions: ${bad.join(", ")}` : `${results.length} partitions healthy` };
  }
}
