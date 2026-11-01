import { AirtableProvider, airtableTokenResolver, NotionProvider, notionTokenResolver, PersonalConnectionStore } from "@platform/connectors";
import { createRepositories, type Database } from "@platform/database";
import { SecretSealer, type PlatformConfig } from "@platform/security";
import { adapterFor, chunkText, createEmbedder, embedMissingDocuments, ingestSource, type IngestionReport, type IngestionStore, type SourceConfig } from "@platform/knowledge";

/** The generic pipeline's storage, backed by the platform database. */
export function ingestionStore(db: Database): IngestionStore {
  const repos = createRepositories(db);
  return {
    listCatalog: (c) => repos.catalog.listAll(c),
    upsertCatalog: (d) => repos.catalog.upsert(d),
    setAcl: (c, id, acl) => repos.catalog.setAcl(c, id, acl),
    tombstone: (c, id) => repos.catalog.tombstone(c, id),
    getContent: async (c, id) => {
      const r = await repos.content.get(c, id);
      return r ? { version: r.version, contentHash: r.contentHash } : undefined;
    },
    putContent: (row) => repos.content.put(row),
    getState: async (c, s) => {
      const r = await repos.sources.getState(c, s);
      return r ? { cursor: r.cursor } : undefined;
    },
    saveState: (c, s, cursor, report) => repos.sources.saveState(c, s, cursor, report),
    quarantine: (row) => repos.sources.quarantine(row),
    release: (c, s, id) => repos.sources.release(c, s, id),
    listQuarantined: (c, s) => repos.sources.listQuarantinedVersions(c, s),
  };
}

/** How source adapters get their credentials: env secrets, and the admin's "Connect Notion" / "Connect Airtable" (ADR 0015). */
export function adapterOptions(config: PlatformConfig, db: Database) {
  const { notion: n, airtable: a, connectionEncryptionKey: key } = config.integrations;
  const store = key ? new PersonalConnectionStore(createRepositories(db).connections, new SecretSealer(key)) : undefined;
  return {
    secret: (name: string) => process.env[name],
    notionConnection: n && store ? notionTokenResolver(store, new NotionProvider(n), config.customerId) : undefined,
    airtableConnection: a && store ? airtableTokenResolver(store, new AirtableProvider(a), config.customerId) : undefined,
  };
}

/** Ingests every configured source (or one). Sources run one after another; one failing source never blocks the others. */
export async function ingestAll(
  db: Database,
  customerId: string,
  sources: readonly SourceConfig[],
  log: (msg: string, detail?: Record<string, unknown>) => void,
  only?: string,
  adapterOpts: Parameters<typeof adapterFor>[1] = {},
): Promise<Record<string, IngestionReport>> {
  const store = ingestionStore(db);
  const out: Record<string, IngestionReport> = {};
  for (const s of sources) {
    if (only && s.id !== only) continue;
    try {
      out[s.id] = await ingestSource(customerId, s, adapterFor(s, adapterOpts), store, log);
    } catch (err) {
      log("source ingestion failed", { source: s.id, error: (err as Error).message });
    }
  }
  if (only && !out[only] && !sources.some((s) => s.id === only)) throw new Error(`unknown source ${only}`);
  return out;
}

/**
 * Hybrid retrieval (ADR 0017): embeds the passages of documents that have none yet
 * for the configured model (new documents, new versions, a changed model), so the
 * first searches don't have to. Never fails the ingestion run: search embeds
 * whatever is still missing.
 */
export async function embedNewDocuments(db: Database, config: PlatformConfig, log: (msg: string, detail?: Record<string, unknown>) => void): Promise<number> {
  const s = config.evidenceScoring;
  if (s.mode !== "hybrid") return 0;
  const repos = createRepositories(db);
  const docs = (await repos.catalog.listAll(config.customerId)).filter((d) => !d.tombstoned);
  try {
    const n = await embedMissingDocuments(docs, {
      index: repos.embeddings,
      embedder: createEmbedder(s),
      chunks: async (doc) => {
        const row = await repos.content.get(doc.customerId, doc.documentId);
        return row && row.version === doc.version ? chunkText(doc.documentId, row.text).map((c) => ({ ...c, documentId: doc.documentId, score: 1 })) : [];
      },
    });
    if (n) log("passage embeddings updated", { documents: n, model: s.model });
    return n;
  } catch (err) {
    log("passage embedding failed; search embeds what is missing", { error: (err as Error).message });
    return 0;
  }
}
