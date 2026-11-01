/** Passage embeddings on PGlite with pgvector (ADR 0017): real migrations, real SQL. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositories, seedIdentities, type Database } from "../src/index.js";
import { createTestDatabase } from "../src/testing.js";

const C = "cust_demo";
let db: Database;
let close: () => Promise<void>;
let repos: ReturnType<typeof createRepositories>;

async function doc(documentId: string, version: string) {
  await repos.catalog.upsert({ customerId: C, documentId, sourceId: "s", version, title: documentId, aclGroups: ["all-staff"], externalRef: {}, indexedAt: new Date(), contentHash: version });
  await repos.content.put({ customerId: C, documentId, version, mimeType: "text/plain", text: "x", contentHash: version });
}

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  repos = createRepositories(db);
  await seedIdentities(db, { id: C, name: "Demo" }, []);
  await doc("travel", "v1");
  await doc("leave", "v1");
  await doc("secret", "v1");
  await repos.embeddings.replaceDocument(C, "travel", "v1", "m", "f1", [{ chunkId: "travel#c1", embedding: [1, 0, 0] }, { chunkId: "travel#c2", embedding: [0.7, 0.7, 0] }]);
  await repos.embeddings.replaceDocument(C, "leave", "v1", "m", "f1", [{ chunkId: "leave#c1", embedding: [0, 1, 0] }]);
  await repos.embeddings.replaceDocument(C, "secret", "v1", "m", "f1", [{ chunkId: "secret#c1", embedding: [1, 0, 0] }]);
});
afterAll(async () => close?.());

describe("passage embeddings", () => {
  it("returns the nearest passages of the authorized documents only, by cosine", async () => {
    const r = await repos.embeddings.nearest(C, "m", "f1", [1, 0, 0], [{ documentId: "travel", version: "v1" }, { documentId: "leave", version: "v1" }], 2);
    expect(r.map((x) => x.chunkId)).toEqual(["travel#c1", "travel#c2"]);
    expect(r[0]!.cosine).toBeCloseTo(1, 5);
    expect(r.map((x) => x.documentId)).not.toContain("secret");
  });

  it("adds the passages asked for by id, still only within the authorized documents", async () => {
    const r = await repos.embeddings.nearest(C, "m", "f1", [1, 0, 0], [{ documentId: "travel", version: "v1" }, { documentId: "leave", version: "v1" }], 1, ["leave#c1", "secret#c1"]);
    expect(r.map((x) => x.chunkId).sort()).toEqual(["leave#c1", "travel#c1"]);
    expect(r.find((x) => x.chunkId === "leave#c1")!.cosine).toBeCloseTo(0, 5);
  });

  it("never uses another version, model, format or vector size", async () => {
    const travelV2 = [{ documentId: "travel", version: "v2" }];
    expect(await repos.embeddings.nearest(C, "m", "f1", [1, 0, 0], travelV2, 5)).toEqual([]);
    expect(await repos.embeddings.covered(C, "m", "f1", travelV2)).toEqual(new Set());
    expect(await repos.embeddings.nearest(C, "other-model", "f1", [1, 0, 0], [{ documentId: "travel", version: "v1" }], 5)).toEqual([]);
    expect(await repos.embeddings.nearest(C, "m", "f2", [1, 0, 0], [{ documentId: "travel", version: "v1" }], 5)).toEqual([]);
    expect(await repos.embeddings.nearest(C, "m", "f1", [1, 0], [{ documentId: "travel", version: "v1" }], 5)).toEqual([]);
    expect(await repos.embeddings.covered(C, "m", "f1", [{ documentId: "travel", version: "v1" }, { documentId: "leave", version: "v1" }])).toEqual(new Set(["travel", "leave"]));
  });

  it("replacing a document drops its old version's passages; tombstoning deletes its vectors", async () => {
    await doc("leave", "v2");
    await repos.embeddings.replaceDocument(C, "leave", "v2", "m", "f1", [{ chunkId: "leave#c1", embedding: [0, 0, 1] }]);
    expect(await repos.embeddings.covered(C, "m", "f1", [{ documentId: "leave", version: "v1" }])).toEqual(new Set());
    expect(await repos.embeddings.covered(C, "m", "f1", [{ documentId: "leave", version: "v2" }])).toEqual(new Set(["leave"]));

    await repos.catalog.tombstone(C, "secret");
    const left = await db.execute(`select count(*)::int as n from passage_embeddings where document_id = 'secret'`);
    expect(((left as unknown as { rows?: { n: number }[] }).rows ?? (left as unknown as { n: number }[]))[0]!.n).toBe(0);
  });
});
