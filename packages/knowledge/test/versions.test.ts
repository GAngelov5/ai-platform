import { describe, expect, it } from "vitest";
import { PolicyEnforcingKnowledgeService, supersededVersions, type CatalogDocument, type KnowledgeAdapter } from "../src/index.js";
import { CUSTOMER, ctxFor, memoryWorld } from "./helpers.js";

const doc = (documentId: string, aclGroups: string[], sourceId = "share"): CatalogDocument => ({
  customerId: CUSTOMER,
  documentId,
  sourceId,
  version: "1",
  title: documentId,
  aclGroups,
  aclRevision: 1,
  externalRef: {},
  indexedAt: new Date("2026-10-01T00:00:00Z"),
  tombstoned: false,
});

describe("version families", () => {
  it("maps every older version to the highest one, per source and base name", () => {
    const m = supersededVersions([
      doc("share:plan-v1.md", []),
      doc("share:plan-v2.docx", []),
      doc("share:plan-v10.pdf", []),
      doc("share:spec_v1.md", []),
      doc("other:plan-v1.md", [], "other"),
      doc("share:notes.md", []),
    ]);
    expect(Object.fromEntries(m)).toEqual({ "share:plan-v1.md": "share:plan-v10.pdf", "share:plan-v2.docx": "share:plan-v10.pdf" });
  });

  it("ranks superseded versions below current ones and labels them, without revealing unreadable versions", async () => {
    const w = await memoryWorld();
    w.catalog.clear();
    for (const d of [doc("share:go-live-v1.md", ["all-staff"]), doc("share:go-live-v2.md", ["atlas-team"])]) w.catalog.set(d.documentId, d);
    // A backend that prefers the old version (as lexical scoring did for the eval corpus).
    const adapter: KnowledgeAdapter = {
      name: "fixed",
      search: async (req) =>
        ["share:go-live-v1.md", "share:go-live-v2.md"]
          .filter((id) => req.documents.some((d) => d.documentId === id))
          .map((id, i) => ({ documentId: id, chunkId: `${id}#0`, text: "go-live date", score: i === 0 ? 0.9 : 0.8 })),
      getDocumentChunks: async () => [],
      health: async () => ({ ok: true }),
    };
    const svc = new PolicyEnforcingKnowledgeService({ catalog: w.catalogApi, principals: w.principals, ledger: w.ledger, adapter, policySourceIds: ["share"] });

    const alice = await svc.search(ctxFor("alice"), { query: "go-live", limit: 5 });
    expect(alice.map((e) => e.documentId)).toEqual(["share:go-live-v2.md", "share:go-live-v1.md"]);
    expect(alice[1]).toMatchObject({ supersededBy: "share:go-live-v2.md", score: 0.9 }); // score kept: still usable evidence
    expect(alice[0]!.supersededBy).toBeUndefined();

    // Bob cannot read v2: v1 is his current version, and v2 is never named.
    const bob = await svc.search(ctxFor("bob"), { query: "go-live", limit: 5 });
    expect(bob).toHaveLength(1);
    expect(bob[0]).toMatchObject({ documentId: "share:go-live-v1.md", score: 0.9 });
    expect(JSON.stringify(bob)).not.toContain("v2");
  });
});
