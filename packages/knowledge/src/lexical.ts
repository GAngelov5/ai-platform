import type { AdapterChunk, AdapterSearchRequest, CatalogDocument, KnowledgeAdapter } from "./types.js";
import type { TextChunk } from "./ingestion/chunk.js";
import { terms } from "./text.js";

/** Loads the chunks of exactly this document version, or [] if that version isn't stored. */
export type ChunkLoader = (doc: CatalogDocument) => Promise<TextChunk[]>;

/**
 * Deterministic lexical retrieval over the platform's own content. Only
 * chunks of `req.documents` (the authorized prefilter) are ever loaded or
 * scored. Score = fraction of distinct query terms present in the chunk,
 * term frequency breaks ties.
 */
export class LexicalKnowledgeAdapter implements KnowledgeAdapter {
  constructor(
    private readonly loadChunks: ChunkLoader,
    readonly name = "lexical",
    private readonly healthDetail: () => Promise<{ ok: boolean; detail?: string }> = async () => ({ ok: true, detail: "platform content store" }),
  ) {}

  async search(req: AdapterSearchRequest): Promise<AdapterChunk[]> {
    const q = [...new Set(terms(req.query))];
    if (q.length === 0) return [];
    const scored: (AdapterChunk & { tf: number })[] = [];
    for (const doc of req.documents) {
      for (const c of await this.loadChunks(doc)) {
        const t = terms(`${doc.title} ${c.location ?? ""} ${c.text}`);
        const present = q.filter((x) => t.includes(x)).length;
        if (present === 0) continue;
        const tf = t.filter((x) => q.includes(x)).length;
        scored.push({ documentId: doc.documentId, chunkId: c.chunkId, text: c.text, location: c.location, score: present / q.length, tf });
      }
    }
    scored.sort((a, b) => b.score - a.score || b.tf - a.tf || a.chunkId.localeCompare(b.chunkId));
    return scored.slice(0, req.limit).map(({ tf: _tf, ...rest }) => rest);
  }

  async getDocumentChunks(doc: CatalogDocument): Promise<AdapterChunk[]> {
    return (await this.loadChunks(doc)).map((c) => ({ documentId: doc.documentId, chunkId: c.chunkId, text: c.text, location: c.location, score: 1 }));
  }

  health() {
    return this.healthDetail();
  }
}
