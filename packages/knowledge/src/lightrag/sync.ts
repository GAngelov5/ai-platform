import type { CatalogDocument } from "../types.js";
import { LightRagClient, type LightRagDocument } from "./client.js";
import {
  fileSourceFor,
  LIGHTRAG_REF_DOC_ID,
  LIGHTRAG_REF_FILE_SOURCE,
  LIGHTRAG_REF_PARTITION,
  partitionFor,
  type LightRagPartition,
} from "./partitions.js";

export interface LightRagSyncTarget {
  /** All catalog documents for the customer, including tombstoned ones. */
  listAll(): Promise<CatalogDocument[]>;
  setExternalRef(documentId: string, ref: Record<string, string>): Promise<void>;
  /** Plain text to index for a document (the platform's ingestion copy). */
  content(doc: CatalogDocument): Promise<string | undefined>;
}

export interface LightRagSyncReport {
  inserted: string[];
  deleted: { partition: string; fileSource: string }[];
  unchanged: string[];
  unpartitioned: string[];
  failed: { documentId: string; reason: string }[];
  deletionVerified: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reconciles the platform catalog into LightRAG access partitions.
 *
 * Access decisions never wait for this: the adapter already ignores content
 * whose placement or version no longer matches the catalog. This job makes
 * the physical index converge — insert new/updated versions, move documents
 * whose ACL changed, delete tombstoned or superseded content — and verifies
 * each deletion before moving on.
 */
export async function syncLightRagPartitions(
  partitions: readonly LightRagPartition[],
  opts: { apiKey: string; timeoutMs: number; fetch?: typeof fetch; pollMs?: number; maxWaitMs?: number },
  target: LightRagSyncTarget,
  log: (msg: string) => void,
): Promise<LightRagSyncReport> {
  const report: LightRagSyncReport = { inserted: [], deleted: [], unchanged: [], unpartitioned: [], failed: [], deletionVerified: true };
  const pollMs = opts.pollMs ?? 3000;
  const deadline = Date.now() + (opts.maxWaitMs ?? 30 * 60_000);
  const clients = new Map(partitions.map((p) => [p.id, new LightRagClient({ baseUrl: p.url, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, fetch: opts.fetch })]));

  const catalog = await target.listAll();
  // Desired placement: partitionId -> fileSource -> document
  const desired = new Map<string, Map<string, CatalogDocument>>(partitions.map((p) => [p.id, new Map()]));
  for (const d of catalog) {
    if (d.tombstoned) continue;
    const p = partitionFor(d, partitions);
    if (!p) {
      report.unpartitioned.push(d.documentId);
      if (d.externalRef[LIGHTRAG_REF_PARTITION]) await target.setExternalRef(d.documentId, {});
      log(`no partition with identical access for ${d.documentId} (${d.sourceId} / ${d.aclGroups.join(",")}); not indexed`);
      continue;
    }
    desired.get(p.id)!.set(fileSourceFor(d), d);
  }

  for (const p of partitions) {
    const client = clients.get(p.id)!;
    const present = new Map<string, LightRagDocument>((await client.listDocuments()).map((x) => [x.file_path.split("/").pop()!, x]));
    const want = desired.get(p.id)!;

    // 1. Delete anything that should not be in this partition (tombstoned, superseded, moved).
    for (const [fileSource, doc] of present) {
      if (want.has(fileSource) && doc.status !== "failed") continue;
      await waitIdle(client, pollMs, deadline);
      const r = await client.deleteDocuments([doc.id]);
      if (r.status !== "deletion_started") throw new Error(`LightRAG refused deletion in ${p.id}: ${r.status}`);
      log(`deleting ${fileSource} from ${p.id}`);
      // Confirm before continuing: LightRAG document IDs are content-derived, so a
      // re-insert of the same content reuses the ID and would mask an unfinished delete.
      if (!(await confirmDeleted(client, doc.id, pollMs, deadline))) {
        report.deletionVerified = false;
        log(`deletion not confirmed in ${p.id}: ${doc.id}`);
      }
      report.deleted.push({ partition: p.id, fileSource });
      present.delete(fileSource);
    }

    // 2. Insert what is missing; publish the reference only after processing succeeds.
    for (const [fileSource, d] of want) {
      let existing = present.get(fileSource);
      // In flight from an earlier run: wait for it instead of re-inserting (409 same-name conflict).
      while (existing && existing.status !== "processed" && existing.status !== "failed") {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${fileSource} in ${p.id}`);
        await sleep(pollMs);
        existing = (await client.listDocuments()).find((x) => x.id === existing!.id);
      }
      if (existing?.status === "failed") {
        await waitIdle(client, pollMs, deadline);
        await client.deleteDocuments([existing.id]);
        if (!(await confirmDeleted(client, existing.id, pollMs, deadline))) report.deletionVerified = false;
        existing = undefined;
      }
      if (existing?.status === "processed") {
        const ref = { [LIGHTRAG_REF_PARTITION]: p.id, [LIGHTRAG_REF_DOC_ID]: existing.id, [LIGHTRAG_REF_FILE_SOURCE]: fileSource };
        if (d.externalRef[LIGHTRAG_REF_DOC_ID] !== existing.id || d.externalRef[LIGHTRAG_REF_PARTITION] !== p.id) await target.setExternalRef(d.documentId, ref);
        report.unchanged.push(d.documentId);
        continue;
      }
      const text = await target.content(d);
      if (!text) {
        report.failed.push({ documentId: d.documentId, reason: "no content available" });
        continue;
      }
      await waitIdle(client, pollMs, deadline);
      const ins = await client.insertText(`# ${d.title}\n\n${text}`, fileSource);
      if (ins.status === "failure") {
        await target.setExternalRef(d.documentId, {});
        report.failed.push({ documentId: d.documentId, reason: ins.message });
        continue;
      }
      log(`indexing ${d.documentId} into ${p.id} (track ${ins.track_id})`);
      for (;;) {
        const st = await client.trackStatus(ins.track_id);
        const doc = st.documents[0];
        if (doc?.status === "processed") {
          await target.setExternalRef(d.documentId, { [LIGHTRAG_REF_PARTITION]: p.id, [LIGHTRAG_REF_DOC_ID]: doc.id, [LIGHTRAG_REF_FILE_SOURCE]: fileSource });
          report.inserted.push(d.documentId);
          break;
        }
        if (doc?.status === "failed") {
          // Never leave a reference to content that did not index; retried on the next sync.
          await target.setExternalRef(d.documentId, {});
          report.failed.push({ documentId: d.documentId, reason: doc.error_msg ?? "processing failed" });
          break;
        }
        if (Date.now() > deadline) throw new Error(`timed out indexing ${d.documentId}`);
        await sleep(pollMs);
      }
    }
  }

  return report;
}

async function confirmDeleted(client: LightRagClient, docId: string, pollMs: number, deadline: number): Promise<boolean> {
  for (;;) {
    await waitIdle(client, pollMs, deadline);
    if (!(await client.listDocuments()).some((x) => x.id === docId)) return true;
    if (Date.now() > deadline) return false;
    await sleep(pollMs);
  }
}

async function waitIdle(client: LightRagClient, pollMs: number, deadline: number) {
  while ((await client.pipelineStatus()).busy) {
    if (Date.now() > deadline) throw new Error("LightRAG pipeline stayed busy");
    await sleep(pollMs);
  }
}
