import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRepositories, seedIdentities, type Database, type FixtureIdentity } from "@platform/database";
import { loadFixtureCorpus } from "@platform/knowledge";

export interface IdentityFixtureFile {
  customer: { id: string; name: string };
  principals: FixtureIdentity[];
}

/**
 * Seeds synthetic identities and the platform document catalog from fixtures.
 * Catalog entries carry source, version and ACL; content stays in the adapter.
 * Documents no longer present in the fixtures are tombstoned.
 */
export async function seedFixtures(db: Database, fixturesRoot: string, customerId: string): Promise<{ principals: number; documents: number; tombstoned: number }> {
  const identities = JSON.parse(await readFile(join(fixturesRoot, "identities.json"), "utf8")) as IdentityFixtureFile;
  if (identities.customer.id !== customerId) {
    throw new Error(`fixture customer ${identities.customer.id} does not match CUSTOMER_ID ${customerId}`);
  }
  await seedIdentities(db, identities.customer, identities.principals);
  const repos = createRepositories(db);
  const corpus = await loadFixtureCorpus(join(fixturesRoot, "documents"));
  const existing = new Map((await repos.catalog.listAll(customerId)).map((d) => [d.documentId, d]));
  for (const d of corpus) {
    const prev = existing.get(d.documentId);
    await repos.catalog.upsert({
      customerId,
      documentId: d.documentId,
      sourceId: d.sourceId,
      version: d.version,
      title: d.title,
      sourceUrl: d.sourceUrl,
      aclGroups: d.aclGroups,
      contentHash: d.contentHash,
      // Keep the RAG backend reference only if the content is unchanged.
      externalRef: prev && prev.version === d.version ? prev.externalRef : {},
      indexedAt: d.indexedAt,
    });
    existing.delete(d.documentId);
  }
  for (const gone of existing.values()) await repos.catalog.tombstone(customerId, gone.documentId);
  return { principals: identities.principals.length, documents: corpus.length, tombstoned: existing.size };
}
