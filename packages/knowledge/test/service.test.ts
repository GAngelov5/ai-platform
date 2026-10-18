import { describe, expect, it } from "vitest";
import { NotFoundOrForbiddenError } from "@platform/security";
import { FixtureKnowledgeAdapter, PolicyEnforcingKnowledgeService, type KnowledgeAdapter } from "../src/index.js";
import { CANARY, ctxFor, memoryWorld } from "./helpers.js";

const SOURCES = ["atlas-project-docs", "company-handbook"];

async function setup(adapterOverride?: (base: KnowledgeAdapter) => KnowledgeAdapter) {
  const w = await memoryWorld();
  const base = new FixtureKnowledgeAdapter(w.corpus);
  const seen: string[][] = [];
  const spy: KnowledgeAdapter = {
    name: "spy",
    search: (req) => {
      seen.push(req.documents.map((d) => d.documentId));
      return (adapterOverride ? adapterOverride(base) : base).search(req);
    },
    getDocumentChunks: (d) => base.getDocumentChunks(d),
    health: () => base.health(),
  };
  const events: string[] = [];
  const svc = new PolicyEnforcingKnowledgeService({
    catalog: w.catalogApi,
    principals: w.principals,
    ledger: w.ledger,
    adapter: spy,
    policySourceIds: SOURCES,
    onSecurityEvent: (e) => events.push(e.type),
  });
  return { ...w, svc, seen, events };
}

describe("PolicyEnforcingKnowledgeService (fixture adapter)", () => {
  it("returns supporting Atlas evidence to a permitted principal", async () => {
    const { svc } = await setup();
    const ev = await svc.search(ctxFor("alice"), { query: "Why was Project Atlas delayed?", limit: 5 });
    const docs = new Set(ev.map((e) => e.documentId));
    expect(docs.has("atlas-status-2026-04")).toBe(true);
    expect(docs.has("atlas-steering-2026-05-12")).toBe(true);
    expect(ev.every((e) => /^ev_/.test(e.evidenceId) && e.indexedAt && e.version)).toBe(true);
  });

  it("never passes forbidden documents to the adapter, and never returns their text", async () => {
    const { svc, seen } = await setup();
    const ev = await svc.search(ctxFor("alice"), { query: "Atlas delay Northwind contract dispute settlement", limit: 10 });
    expect(seen.flat()).not.toContain("atlas-contract-dispute");
    expect(JSON.stringify(ev)).not.toContain(CANARY);
    expect(JSON.stringify(ev)).not.toContain("RESTRICTED");
  });

  it("returns nothing about Atlas to the denied principal", async () => {
    const { svc, seen } = await setup();
    const ev = await svc.search(ctxFor("bob"), { query: "Why was Project Atlas delayed?", limit: 5 });
    expect(ev).toEqual([]);
    expect(seen.flat().every((id) => id === "office-relocation-faq")).toBe(true);
  });

  it("lets the finance-legal principal see the restricted memo", async () => {
    const { svc } = await setup();
    const ev = await svc.search(ctxFor("carol"), { query: "Atlas Northwind contract dispute", limit: 5 });
    expect(ev.some((e) => e.documentId === "atlas-contract-dispute")).toBe(true);
  });

  it("drops chunks an adapter returns outside the authorized prefilter", async () => {
    const { svc, events } = await setup(() => ({
      name: "leaky",
      search: async () => [{ documentId: "atlas-contract-dispute", chunkId: "x#1", text: CANARY, score: 1 }],
      getDocumentChunks: async () => [],
      health: async () => ({ ok: true }),
    }));
    const ev = await svc.search(ctxFor("alice"), { query: "anything", limit: 5 });
    expect(ev).toEqual([]);
    expect(events).toContain("adapter_returned_unauthorized_chunk");
  });

  it("restricts search to the server-provided agent scope", async () => {
    const { svc, seen } = await setup();
    await svc.search(ctxFor("alice"), { query: "office parking", limit: 5, sourceIds: ["company-handbook"] });
    expect(seen.flat()).toEqual(["office-relocation-faq"]);
    // A scope outside application policy is ignored, not widened.
    const none = await svc.search(ctxFor("alice"), { query: "office parking", limit: 5, sourceIds: ["hr-private"] });
    expect(none).toEqual([]);
  });

  it("protects document views and evidence resolution", async () => {
    const { svc } = await setup();
    await expect(svc.getDocument(ctxFor("alice"), "atlas-contract-dispute")).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
    await expect(svc.getDocument(ctxFor("alice"), "does-not-exist")).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
    const view = await svc.getDocument(ctxFor("alice"), "atlas-status-2026-04");
    expect(view.chunks.length).toBeGreaterThan(0);

    const [first] = await svc.search(ctxFor("alice"), { query: "Atlas delayed", limit: 1 });
    expect(await svc.resolveEvidence(ctxFor("alice"), first!.evidenceId)).toMatchObject({ documentId: first!.documentId });
    // Issued to alice: not resolvable by anyone else, even someone who can read the document.
    await expect(svc.resolveEvidence(ctxFor("carol"), first!.evidenceId)).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
  });

  it("applies tombstones and ACL revocation immediately", async () => {
    const { svc, catalog } = await setup();
    const [first] = await svc.search(ctxFor("alice"), { query: "Atlas delayed", limit: 1 });
    const doc = catalog.get(first!.documentId)!;
    catalog.set(doc.documentId, { ...doc, aclGroups: ["finance-legal"], aclRevision: 2 });
    await expect(svc.resolveEvidence(ctxFor("alice"), first!.evidenceId)).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
    catalog.set(doc.documentId, { ...doc, tombstoned: true });
    const after = await svc.search(ctxFor("alice"), { query: "Atlas delayed", limit: 10 });
    expect(after.some((e) => e.documentId === doc.documentId)).toBe(false);
  });

  it("rejects unknown principals", async () => {
    const { svc } = await setup();
    await expect(svc.search(ctxFor("mallory"), { query: "Atlas", limit: 5 })).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
  });
});
