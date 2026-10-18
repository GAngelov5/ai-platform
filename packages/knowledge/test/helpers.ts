import { fileURLToPath } from "node:url";
import { createTrustedContext, type Principal } from "@platform/security";
import {
  loadFixtureCorpus,
  type CatalogDocument,
  type DocumentCatalog,
  type EvidenceLedger,
  type FixtureDocument,
  type IssuedEvidence,
  type PrincipalDirectory,
} from "../src/index.js";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/documents", import.meta.url));
export const CANARY = "FORBIDDEN-CANARY-7Q4X";
export const CUSTOMER = "cust_demo";

export const PRINCIPALS: Record<string, Principal> = {
  alice: { id: "alice", customerId: CUSTOMER, displayName: "Alice", groups: ["all-staff", "atlas-team"], roles: [], disabled: false },
  bob: { id: "bob", customerId: CUSTOMER, displayName: "Bob", groups: ["all-staff"], roles: [], disabled: false },
  carol: { id: "carol", customerId: CUSTOMER, displayName: "Carol", groups: ["all-staff", "atlas-team", "finance-legal"], roles: [], disabled: false },
};

/** In-memory test doubles for the platform catalog and ledger (the API tests use the real PostgreSQL schema). */
export async function memoryWorld() {
  const corpus = await loadFixtureCorpus(FIXTURES);
  const catalog = new Map<string, CatalogDocument>(
    corpus.map((d: FixtureDocument) => [
      d.documentId,
      {
        customerId: CUSTOMER,
        documentId: d.documentId,
        sourceId: d.sourceId,
        version: d.version,
        title: d.title,
        sourceUrl: d.sourceUrl,
        aclGroups: d.aclGroups,
        aclRevision: 1,
        externalRef: {},
        indexedAt: d.indexedAt,
        tombstoned: false,
      },
    ]),
  );
  const issued = new Map<string, IssuedEvidence>();
  const catalogApi: DocumentCatalog = {
    async listReadable(customerId, groups, sourceIds) {
      return [...catalog.values()].filter(
        (d) => d.customerId === customerId && !d.tombstoned && sourceIds.includes(d.sourceId) && d.aclGroups.some((g) => groups.includes(g)),
      );
    },
    async get(customerId, id) {
      const d = catalog.get(id);
      return d && d.customerId === customerId ? d : undefined;
    },
  };
  const ledger: EvidenceLedger = {
    async record(rows) {
      for (const r of rows) issued.set(r.evidenceId, r);
    },
    async get(customerId, id) {
      const r = issued.get(id);
      return r && r.customerId === customerId ? r : undefined;
    },
  };
  const principals: PrincipalDirectory = { get: async (c, id) => (PRINCIPALS[id]?.customerId === c ? PRINCIPALS[id] : undefined) };
  return { corpus, catalog, issued, catalogApi, ledger, principals };
}

export const ctxFor = (principalId: string) => createTrustedContext({ customerId: CUSTOMER, principalId, policyVersion: "test" });
