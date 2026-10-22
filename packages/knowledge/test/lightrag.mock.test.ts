/**
 * MOCK TESTS. An in-memory fake of the LightRAG v1.5.7 HTTP API (shapes copied
 * from responses captured from a running v1.5.7 container). They check the
 * adapter's partition routing and the sync's reconciliation logic. The real
 * service is exercised by scripts/lightrag-live-check.mjs.
 */
import { describe, expect, it } from "vitest";
import {
  fileSourceFor,
  LightRagKnowledgeAdapter,
  LightRagPartitionsSchema,
  partitionFor,
  syncLightRagPartitions,
  type CatalogDocument,
  type LightRagPartition,
} from "../src/index.js";

// Legacy single-source form; normalized to sourceIds by the schema.
const PARTS: LightRagPartition[] = LightRagPartitionsSchema.parse([
  { id: "p_team", url: "http://lr-team:9621", sourceId: "atlas", aclGroups: ["atlas-team"] },
  { id: "p_legal", url: "http://lr-legal:9621", sourceIds: ["atlas"], aclGroups: ["finance-legal"] },
]);

interface FakeDoc {
  id: string;
  file_path: string;
  content: string;
  status: string;
}

/** Minimal fake LightRAG cluster keyed by partition host. */
function fakeCluster() {
  const stores = new Map<string, FakeDoc[]>([
    ["lr-team", []],
    ["lr-legal", []],
  ]);
  const calls: { host: string; method: string; path: string; body?: unknown }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const host = u.hostname;
    const docs = stores.get(host)!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ host, method: init?.method ?? "GET", path: u.pathname, body });
    if (new Headers(init?.headers).get("x-api-key") !== "k") return json({ detail: "bad key" }, 401);
    const route = `${init?.method ?? "GET"} ${u.pathname}`;
    if (route === "POST /query/data") {
      return json({
        status: "success",
        data: {
          entities: [{ entity_name: "MERGED SUMMARY", description: "never consumed" }],
          chunks: docs.map((d, i) => ({ content: d.content, file_path: d.file_path, chunk_id: `${d.id}-chunk-00${i}`, reference_id: String(i + 1) })),
        },
        metadata: {},
      });
    }
    if (route === "POST /documents/text") {
      if (docs.some((d) => d.file_path === body.file_source)) return json({ detail: "conflict" }, 409);
      // Like LightRAG, IDs are derived from content: re-inserting identical text reuses the ID.
      const id = `doc-${Buffer.from(body.text).toString("base64url").slice(0, 16)}`;
      docs.push({ id, file_path: body.file_source, content: body.text, status: "processed" });
      return json({ status: "success", message: "ok", track_id: `track-${id}` });
    }
    if (u.pathname.startsWith("/documents/track_status/")) {
      const id = u.pathname.split("track-")[1];
      return json({ track_id: "t", total_count: 1, documents: docs.filter((d) => d.id === id).map(view) });
    }
    if (route === "POST /documents/paginated") return json({ documents: docs.map(view), pagination: { page: 1, total_pages: 1 } });
    if (route === "DELETE /documents/delete_document") {
      stores.set(host, docs.filter((d) => !body.doc_ids.includes(d.id)));
      return json({ status: "deletion_started", message: "ok", doc_id: body.doc_ids[0] });
    }
    if (route === "GET /documents/pipeline_status") return json({ busy: false });
    if (route === "GET /health") return json({ status: "healthy" });
    return json({ detail: "not found" }, 404);
  }) as unknown as typeof fetch;
  const view = (d: FakeDoc) => ({ id: d.id, status: d.status, file_path: d.file_path, chunks_count: 1 });
  return { f, stores, calls };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const doc = (id: string, acl: string[], over: Partial<CatalogDocument> = {}): CatalogDocument => ({
  customerId: "c",
  documentId: id,
  sourceId: "atlas",
  version: "v1",
  title: `Atlas ${id}`,
  aclGroups: acl,
  aclRevision: 1,
  externalRef: {},
  indexedAt: new Date(),
  tombstoned: false,
  ...over,
});

function catalogTarget(docs: CatalogDocument[]) {
  const byId = new Map(docs.map((d) => [d.documentId, d]));
  return {
    byId,
    target: {
      listAll: async () => [...byId.values()],
      setExternalRef: async (id: string, ref: Record<string, string>) => void byId.set(id, { ...byId.get(id)!, externalRef: ref }),
      content: async (d: CatalogDocument) => `Atlas delay text for ${d.documentId}`,
    },
  };
}

describe("LightRAG partitions", () => {
  it("places a document only in the partition with identical source and ACL", () => {
    expect(partitionFor(doc("a", ["atlas-team"]), PARTS)?.id).toBe("p_team");
    expect(partitionFor(doc("a", ["atlas-team", "finance-legal"]), PARTS)).toBeUndefined();
    expect(partitionFor(doc("a", ["atlas-team"], { sourceId: "other" }), PARTS)).toBeUndefined();
  });

  it("rejects ambiguous partition configuration", () => {
    const base = { url: "http://x:9621", aclGroups: ["atlas-team"] };
    expect(LightRagPartitionsSchema.safeParse([{ ...base, id: "a", sourceIds: ["atlas", "share"] }, { ...base, id: "b", sourceIds: ["share"] }]).success).toBe(false);
    expect(LightRagPartitionsSchema.safeParse([{ ...base, id: "a", sourceId: "atlas", sourceIds: ["share"] }]).success).toBe(false);
    expect(LightRagPartitionsSchema.safeParse([{ ...base, id: "a", sourceIds: ["atlas", "share"] }]).success).toBe(true);
  });

  it("lets one partition serve several sources with the same access set, never an empty ACL", () => {
    const [multi] = LightRagPartitionsSchema.parse([{ id: "m", url: "http://x:9621", sourceIds: ["atlas", "share"], aclGroups: ["atlas-team"] }]);
    expect(partitionFor(doc("a", ["atlas-team"], { sourceId: "share" }), [multi!])?.id).toBe("m");
    expect(partitionFor(doc("a", [], { sourceId: "share" }), [multi!])).toBeUndefined();
  });
});

describe("syncLightRagPartitions (mocked HTTP)", () => {
  it("inserts, moves on ACL change, deletes tombstones and verifies deletion", async () => {
    const { f, stores } = fakeCluster();
    const { byId, target } = catalogTarget([doc("status", ["atlas-team"]), doc("memo", ["finance-legal"]), doc("mixed", ["atlas-team", "finance-legal"])]);
    const opts = { apiKey: "k", timeoutMs: 1000, fetch: f, pollMs: 1 };

    const r1 = await syncLightRagPartitions(PARTS, opts, target, () => {});
    expect(r1.inserted.sort()).toEqual(["memo", "status"]);
    expect(r1.unpartitioned).toEqual(["mixed"]);
    expect(stores.get("lr-team")!.map((d) => d.file_path)).toEqual([fileSourceFor(doc("status", []))]);
    expect(byId.get("status")!.externalRef.lightragPartition).toBe("p_team");

    // ACL change: status moves from the team partition to the legal partition.
    byId.set("status", { ...byId.get("status")!, aclGroups: ["finance-legal"] });
    // Tombstone: memo must be physically removed.
    byId.set("memo", { ...byId.get("memo")!, tombstoned: true });
    const r2 = await syncLightRagPartitions(PARTS, opts, target, () => {});
    expect(r2.deletionVerified).toBe(true);
    expect(stores.get("lr-team")).toEqual([]);
    expect(stores.get("lr-legal")!.map((d) => d.file_path)).toEqual([fileSourceFor(doc("status", []))]);
    expect(byId.get("status")!.externalRef.lightragPartition).toBe("p_legal");

    // Tombstone undone with identical content: same content-derived ID is re-inserted.
    byId.set("memo", { ...byId.get("memo")!, tombstoned: false });
    const r4 = await syncLightRagPartitions(PARTS, opts, target, () => {});
    expect(r4.inserted).toEqual(["memo"]);
    expect(stores.get("lr-legal")!.map((d) => d.file_path).sort()).toEqual([fileSourceFor(doc("memo", [])), fileSourceFor(doc("status", []))]);

    // Idempotent.
    const r3 = await syncLightRagPartitions(PARTS, opts, target, () => {});
    expect(r3.inserted).toEqual([]);
    expect(r3.deleted).toEqual([]);
  });
});

describe("LightRagKnowledgeAdapter (mocked HTTP)", () => {
  async function indexed() {
    const cluster = fakeCluster();
    const { byId, target } = catalogTarget([doc("status", ["atlas-team"]), doc("memo", ["finance-legal"])]);
    await syncLightRagPartitions(PARTS, { apiKey: "k", timeoutMs: 1000, fetch: cluster.f, pollMs: 1 }, target, () => {});
    const adapter = new LightRagKnowledgeAdapter({
      partitions: PARTS,
      apiKey: "k",
      timeoutMs: 1000,
      queryMode: "mix",
      documentContent: async () => [],
      fetch: cluster.f,
    });
    return { ...cluster, byId, adapter };
  }

  it("queries only partitions of authorized documents and returns verbatim chunks", async () => {
    const { adapter, byId, calls } = await indexed();
    calls.length = 0;
    const out = await adapter.search({ query: "Atlas delay", limit: 5, documents: [byId.get("status")!] });
    expect(calls.filter((c) => c.path === "/query/data").map((c) => c.host)).toEqual(["lr-team"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ documentId: "status", score: 1 });
    expect(JSON.stringify(out)).not.toContain("MERGED SUMMARY");
  });

  it("skips documents whose ACL changed since the last sync (stale placement)", async () => {
    const { adapter, byId, calls } = await indexed();
    calls.length = 0;
    const moved = { ...byId.get("status")!, aclGroups: ["finance-legal"] }; // still physically in p_team
    expect(await adapter.search({ query: "Atlas delay", limit: 5, documents: [moved] })).toEqual([]);
    expect(calls.filter((c) => c.path === "/query/data")).toHaveLength(0);
  });

  it("drops chunks whose file_path is not an authorized current version", async () => {
    const { adapter, byId, stores } = await indexed();
    stores.get("lr-team")!.push({ id: "doc-x", file_path: "intruder__v9.md", content: "Atlas delay secret", status: "processed" });
    const out = await adapter.search({ query: "Atlas delay", limit: 5, documents: [byId.get("status")!] });
    expect(out.map((c) => c.documentId)).toEqual(["status"]);
    const newVersion = { ...byId.get("status")!, version: "v2" }; // catalog moved on, index not yet re-synced
    expect(await adapter.search({ query: "Atlas delay", limit: 5, documents: [newVersion] })).toEqual([]);
  });

  it("keeps LightRAG's own order with ranking: native, and term overlap otherwise", async () => {
    const cluster = fakeCluster();
    const { byId, target } = catalogTarget([doc("first", ["atlas-team"]), doc("second", ["atlas-team"])]);
    target.content = async (d) => (d.documentId === "first" ? "weak match" : "Atlas delay delay strong match");
    await syncLightRagPartitions(PARTS, { apiKey: "k", timeoutMs: 1000, fetch: cluster.f, pollMs: 1 }, target, () => {});
    const docs = [byId.get("first")!, byId.get("second")!];
    const make = (ranking?: "native" | "lexical") =>
      new LightRagKnowledgeAdapter({ partitions: PARTS, apiKey: "k", timeoutMs: 1000, queryMode: "mix", ranking, documentContent: async () => [], fetch: cluster.f });
    // The fake returns chunks in insertion order: "first" is LightRAG's top hit.
    const native = await make("native").search({ query: "delay match", limit: 5, documents: docs });
    expect(native.map((c) => c.documentId)).toEqual(["first", "second"]);
    expect(native[0]!.score).toBe(0.5); // the threshold still sees term overlap
    const lexical = await make().search({ query: "delay match", limit: 5, documents: docs });
    expect(lexical.map((c) => c.documentId)).toEqual(["second", "first"]);
  });

  it("reports unhealthy partitions", async () => {
    const adapter = new LightRagKnowledgeAdapter({
      partitions: PARTS,
      apiKey: "k",
      timeoutMs: 500,
      queryMode: "naive",
      documentContent: async () => [],
      fetch: (async () => {
        throw Object.assign(new Error("down"), { name: "TypeError" });
      }) as unknown as typeof fetch,
    });
    expect(await adapter.health()).toMatchObject({ ok: false });
  });
});
