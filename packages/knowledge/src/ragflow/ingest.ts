import type { FixtureDocument } from "../fixture/corpus.js";
import { RAGFLOW_REF_DATASET, RAGFLOW_REF_DOCUMENT } from "./adapter.js";
import { RagflowClient } from "./client.js";

export interface IngestTarget {
  setExternalRef(documentId: string, ref: Record<string, string>): Promise<void>;
}

/**
 * Uploads synthetic fixture documents to an existing RAGFlow dataset, starts
 * parsing, waits for completion and records the RAGFlow document IDs in the
 * platform catalog. The catalog keeps ownership of ACLs and versions.
 */
export async function ingestFixturesIntoRagflow(
  client: RagflowClient,
  datasetId: string,
  docs: readonly FixtureDocument[],
  target: IngestTarget,
  log: (msg: string) => void,
  opts: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<void> {
  const uploaded: { fixture: FixtureDocument; ragflowId: string }[] = [];
  for (const d of docs) {
    const res = await client.uploadDocument(datasetId, `${d.documentId}__${d.version}.md`, `# ${d.title}\n\n${d.body}\n`);
    const first = res[0];
    if (!first) throw new Error(`RAGFlow upload returned no document for ${d.documentId}`);
    uploaded.push({ fixture: d, ragflowId: first.id });
    log(`uploaded ${d.documentId} -> ${first.id}`);
  }
  await client.parseDocuments(datasetId, uploaded.map((u) => u.ragflowId));
  const deadline = Date.now() + (opts.maxWaitMs ?? 10 * 60_000);
  for (const u of uploaded) {
    for (;;) {
      const st = await client.getDocumentStatus(datasetId, u.ragflowId);
      const run = st.docs[0]?.run;
      if (run === "DONE" || run === "3") break;
      if (run === "FAIL" || run === "4" || run === "CANCEL" || run === "2") {
        throw new Error(`RAGFlow parsing ${run} for ${u.fixture.documentId}; document quarantined (not published)`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for RAGFlow to parse ${u.fixture.documentId}`);
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 3000));
    }
    // Publish the indexed version only after successful processing.
    await target.setExternalRef(u.fixture.documentId, { [RAGFLOW_REF_DATASET]: datasetId, [RAGFLOW_REF_DOCUMENT]: u.ragflowId });
    log(`indexed ${u.fixture.documentId}`);
  }
}
