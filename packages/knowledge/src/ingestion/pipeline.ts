import { createHash } from "node:crypto";
import type { CatalogDocument } from "../types.js";
import { parseContent, UnsupportedTypeError } from "./parse.js";
import type { QuarantineReason, SourceAdapter, SourceConfig, SourceItem } from "./types.js";

/** Storage the pipeline needs (implemented by the database repositories). */
export interface IngestionStore {
  listCatalog(customerId: string): Promise<CatalogDocument[]>;
  upsertCatalog(doc: {
    customerId: string;
    documentId: string;
    sourceId: string;
    version: string;
    title: string;
    sourceUrl?: string;
    aclGroups: string[];
    contentHash: string;
    externalRef: Record<string, string>;
    indexedAt: Date;
  }): Promise<void>;
  setAcl(customerId: string, documentId: string, aclGroups: string[]): Promise<void>;
  tombstone(customerId: string, documentId: string): Promise<void>;
  getContent(customerId: string, documentId: string): Promise<{ version: string; contentHash: string } | undefined>;
  putContent(row: { customerId: string; documentId: string; version: string; mimeType: string; text: string; contentHash: string }): Promise<void>;
  getState(customerId: string, sourceId: string): Promise<{ cursor: string | null } | undefined>;
  saveState(customerId: string, sourceId: string, cursor: string | null, report: IngestionReport): Promise<void>;
  quarantine(row: { customerId: string; sourceId: string; externalId: string; version: string; reason: string; detail?: string }): Promise<void>;
  release(customerId: string, sourceId: string, externalId: string): Promise<void>;
  listQuarantined(customerId: string, sourceId: string): Promise<{ externalId: string; version: string }[]>;
}

export interface IngestionReport {
  startedAt: string;
  finishedAt: string;
  full: boolean;
  upserted: number;
  unchanged: number;
  aclChanged: number;
  tombstoned: number;
  quarantined: number;
  /** Quarantined earlier and unchanged since: skipped without re-fetching. */
  stillQuarantined: number;
  unmappedAcl: number;
  error?: string;
}

/** Stable, ID-safe platform document ID for a source item. */
export function documentIdFor(source: SourceConfig, externalId: string): string {
  const raw = source.prefixDocumentIds ? `${source.id}:${externalId}` : externalId;
  const safe = raw.replace(/[^A-Za-z0-9._:#-]/g, "_");
  if (safe.length <= 160) return safe;
  return `${safe.slice(0, 120)}~${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

/** Native groups -> platform groups. Unmapped groups are dropped; an empty result means unsearchable. */
export function mapAcl(source: SourceConfig, nativeGroups: readonly string[]): string[] {
  const out = source.aclPassThrough ? [...nativeGroups] : nativeGroups.map((g) => source.aclMap[g]).filter((g): g is string => !!g);
  return [...new Set(out)].sort();
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * Generic ingestion for one source (ADR 0009). Idempotent: re-running with
 * no source changes changes nothing. Access checks use the catalog, so a
 * tombstone or ACL change applies immediately; the RAG sync converges the
 * physical index afterwards.
 */
export async function ingestSource(
  customerId: string,
  source: SourceConfig,
  adapter: SourceAdapter,
  store: IngestionStore,
  log: (msg: string, detail?: Record<string, unknown>) => void = () => {},
  opts: { signal?: AbortSignal; now?: () => Date } = {},
): Promise<IngestionReport> {
  const now = opts.now ?? (() => new Date());
  const report: IngestionReport = {
    startedAt: now().toISOString(),
    finishedAt: "",
    full: false,
    upserted: 0,
    unchanged: 0,
    aclChanged: 0,
    tombstoned: 0,
    quarantined: 0,
    stillQuarantined: 0,
    unmappedAcl: 0,
  };
  const state = await store.getState(customerId, source.id);
  const prevCursor = state?.cursor ?? null;

  let set;
  try {
    set = await adapter.listChanges(prevCursor, opts.signal);
  } catch (err) {
    report.error = `listChanges failed: ${(err as Error).message}`.slice(0, 300);
    report.finishedAt = now().toISOString();
    await store.saveState(customerId, source.id, prevCursor, report); // keep the old cursor: retry the same window
    return report;
  }
  report.full = set.full;

  const existing = new Map((await store.listCatalog(customerId)).filter((d) => d.sourceId === source.id).map((d) => [d.documentId, d]));
  const seen = new Set<string>();
  const seenExternal = new Set<string>();
  const quarantinedBefore = new Map((await store.listQuarantined(customerId, source.id)).map((q) => [q.externalId, q.version]));

  const quarantine = async (item: SourceItem, reason: QuarantineReason, detail?: string) => {
    report.quarantined++;
    await store.quarantine({ customerId, sourceId: source.id, externalId: item.externalId, version: item.version, reason, detail: detail?.slice(0, 500) });
    log("quarantined", { source: source.id, item: item.externalId, reason });
  };

  for (const change of set.changes) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    if (change.kind === "delete") {
      const id = documentIdFor(source, change.externalId);
      const prev = existing.get(id);
      if (prev && !prev.tombstoned) {
        await store.tombstone(customerId, id);
        report.tombstoned++;
      }
      await store.release(customerId, source.id, change.externalId);
      continue;
    }

    const item = change.item;
    const documentId = documentIdFor(source, item.externalId);
    seen.add(documentId);
    seenExternal.add(item.externalId);
    if (quarantinedBefore.get(item.externalId) === item.version) {
      report.stillQuarantined++;
      continue;
    }
    const acl = mapAcl(source, item.acl.groups);
    if (acl.length === 0) report.unmappedAcl++;
    const prev = existing.get(documentId);
    const stored = await store.getContent(customerId, documentId);

    // Same content version already stored: only metadata may have changed.
    if (prev && !prev.tombstoned && prev.version === item.version && stored?.version === item.version) {
      if (!sameSet(prev.aclGroups, acl)) {
        await store.setAcl(customerId, documentId, acl);
        report.aclChanged++;
        log("acl changed", { source: source.id, documentId });
      } else {
        report.unchanged++;
      }
      continue;
    }

    if (item.size > source.maxBytes) {
      await quarantine(item, "too_large", `${item.size} bytes > ${source.maxBytes}`);
      continue;
    }
    let text: string;
    try {
      const raw = await adapter.fetchContent(item, opts.signal);
      text = parseContent(raw, item.mimeType);
    } catch (err) {
      if (err instanceof UnsupportedTypeError) await quarantine(item, "unsupported_type", err.mimeType);
      else await quarantine(item, "fetch_error", (err as Error).message);
      continue;
    }
    if (!text.trim()) {
      await quarantine(item, "empty");
      continue;
    }
    const contentHash = createHash("sha256").update(text).digest("hex");
    await store.putContent({ customerId, documentId, version: item.version, mimeType: item.mimeType, text, contentHash });
    await store.upsertCatalog({
      customerId,
      documentId,
      sourceId: source.id,
      version: item.version,
      title: item.title,
      sourceUrl: item.url,
      aclGroups: acl,
      contentHash,
      // A new content version must be re-indexed by the RAG sync.
      externalRef: prev && !prev.tombstoned && prev.version === item.version ? prev.externalRef : {},
      indexedAt: now(),
    });
    await store.release(customerId, source.id, item.externalId);
    report.upserted++;
  }

  if (set.full) {
    for (const externalId of quarantinedBefore.keys()) {
      if (!seenExternal.has(externalId)) await store.release(customerId, source.id, externalId);
    }
    for (const [id, doc] of existing) {
      if (!seen.has(id) && !doc.tombstoned) {
        await store.tombstone(customerId, id);
        report.tombstoned++;
        log("tombstoned (missing from full listing)", { source: source.id, documentId: id });
      }
    }
  }

  report.finishedAt = now().toISOString();
  await store.saveState(customerId, source.id, set.cursor, report);
  return report;
}
