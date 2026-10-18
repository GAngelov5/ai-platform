import type { AdapterChunk, AdapterSearchRequest, CatalogDocument, KnowledgeAdapter } from "../types.js";
import { terms } from "../text.js";
import type { FixtureDocument } from "./corpus.js";

/**
 * In-memory lexical retrieval over synthetic fixtures. It only ever scores
 * chunks belonging to `req.documents` (the authorized prefilter), so corpus
 * statistics from unauthorized documents are never used either.
 *
 * Score = fraction of distinct query terms present in the chunk (coverage),
 * with term frequency as a tie-breaker. Deterministic by design.
 */
export class FixtureKnowledgeAdapter implements KnowledgeAdapter {
  readonly name = "fixture";
  private readonly byId: Map<string, FixtureDocument>;

  constructor(corpus: readonly FixtureDocument[]) {
    this.byId = new Map(corpus.map((d) => [d.documentId, d]));
  }

  async search(req: AdapterSearchRequest): Promise<AdapterChunk[]> {
    const q = [...new Set(terms(req.query))];
    if (q.length === 0) return [];
    const scored: (AdapterChunk & { tf: number })[] = [];
    for (const doc of req.documents) {
      const fx = this.byId.get(doc.documentId);
      if (!fx || fx.version !== doc.version) continue; // only the published indexed version
      for (const c of fx.chunks) {
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
    const fx = this.byId.get(doc.documentId);
    if (!fx || fx.version !== doc.version) return [];
    return fx.chunks.map((c) => ({ documentId: doc.documentId, chunkId: c.chunkId, text: c.text, location: c.location, score: 1 }));
  }

  async health() {
    return { ok: this.byId.size > 0, detail: `${this.byId.size} fixture documents loaded` };
  }
}
