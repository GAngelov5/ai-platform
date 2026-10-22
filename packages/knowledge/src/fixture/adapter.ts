import { LexicalKnowledgeAdapter } from "../lexical.js";
import type { FixtureDocument } from "./corpus.js";

/** Lexical retrieval over in-memory fixtures (tests and offline demos). */
export class FixtureKnowledgeAdapter extends LexicalKnowledgeAdapter {
  constructor(corpus: readonly FixtureDocument[]) {
    const byId = new Map(corpus.map((d) => [d.documentId, d]));
    super(
      async (doc) => {
        const fx = byId.get(doc.documentId);
        return fx && fx.version === doc.version ? fx.chunks : []; // only the published indexed version
      },
      "fixture",
      async () => ({ ok: byId.size > 0, detail: `${byId.size} fixture documents loaded` }),
    );
  }
}
