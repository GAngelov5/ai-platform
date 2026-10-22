import { loadFixtureCorpus, type FixtureDocument } from "../fixture/corpus.js";
import type { SourceAdapter, SourceChangeSet, SourceItem } from "./types.js";

/**
 * Synthetic fixtures (ACL in front matter) as a source. Lists the documents
 * of one sourceId on every run (full listing).
 */
export class FixtureSourceAdapter implements SourceAdapter {
  readonly kind = "fixture";
  private byId = new Map<string, FixtureDocument>();

  constructor(private readonly dir: string, private readonly sourceId: string) {}

  async listChanges(): Promise<SourceChangeSet> {
    const docs = (await loadFixtureCorpus(this.dir)).filter((d) => d.sourceId === this.sourceId);
    this.byId = new Map(docs.map((d) => [d.documentId, d]));
    return {
      full: true,
      cursor: new Date().toISOString(),
      changes: docs.map((d) => ({
        kind: "upsert" as const,
        item: {
          externalId: d.documentId,
          version: d.version,
          title: d.title,
          url: d.sourceUrl,
          modifiedAt: d.indexedAt,
          mimeType: "text/markdown",
          size: Buffer.byteLength(d.body),
          acl: { groups: d.aclGroups },
        },
      })),
    };
  }

  async fetchContent(item: SourceItem): Promise<string> {
    const d = this.byId.get(item.externalId);
    if (!d) throw new Error(`fixture ${item.externalId} disappeared`);
    return d.body;
  }
}
