/**
 * Generic ingestion pipeline (ADR 0009) with the real folder source adapter
 * on a temporary copy of fixtures/sources/team-share, and an in-memory store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunkText,
  defaultSources,
  documentIdFor,
  FolderSourceAdapter,
  ingestSource,
  mapAcl,
  parseContent,
  SourceConfigSchema,
  UnsupportedTypeError,
  type CatalogDocument,
  type IngestionStore,
  type SourceConfig,
} from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const C = "cust_demo";

function memoryStore() {
  const catalog = new Map<string, CatalogDocument>();
  const content = new Map<string, { version: string; contentHash: string; text: string; mimeType: string }>();
  const quarantined = new Map<string, { reason: string; version: string }>();
  const state = new Map<string, string | null>();
  const store: IngestionStore = {
    listCatalog: async () => [...catalog.values()],
    upsertCatalog: async (d) =>
      void catalog.set(d.documentId, { ...d, aclRevision: (catalog.get(d.documentId)?.aclRevision ?? 0) + 1, tombstoned: false }),
    setAcl: async (_c, id, acl) => void catalog.set(id, { ...catalog.get(id)!, aclGroups: acl, aclRevision: catalog.get(id)!.aclRevision + 1 }),
    tombstone: async (_c, id) => void catalog.set(id, { ...catalog.get(id)!, tombstoned: true }),
    getContent: async (_c, id) => content.get(id),
    putContent: async (r) => void content.set(r.documentId, r),
    getState: async (_c, s) => (state.has(s) ? { cursor: state.get(s)! } : undefined),
    saveState: async (_c, s, cursor) => void state.set(s, cursor),
    quarantine: async (r) => void quarantined.set(r.externalId, { reason: r.reason, version: r.version }),
    release: async (_c, _s, id) => void quarantined.delete(id),
    listQuarantined: async () => [...quarantined].map(([externalId, q]) => ({ externalId, version: q.version })),
  };
  return { store, catalog, content, quarantined };
}

let root: string;
let source: SourceConfig;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "team-share-"));
  await cp(join(FIXTURES, "sources", "team-share"), root, { recursive: true });
  source = { ...defaultSources(FIXTURES).find((s) => s.id === "team-share")!, settings: { path: root } };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (m: ReturnType<typeof memoryStore>) => ingestSource(C, source, new FolderSourceAdapter(root, source.id), m.store);
const doc = (m: ReturnType<typeof memoryStore>, rel: string) => m.catalog.get(documentIdFor(source, rel));

describe("ingestSource with the folder adapter", () => {
  it("maps inherited native permissions to platform groups", async () => {
    const m = memoryStore();
    const r = await run(m);
    expect(doc(m, "handbook/it-equipment-policy.md")?.aclGroups).toEqual(["all-staff"]);
    expect(doc(m, "atlas/vendor-contacts.md")?.aclGroups).toEqual(["atlas-team"]);
    expect(doc(m, "atlas/legal/settlement-notes.txt")?.aclGroups).toEqual(["finance-legal"]);
    // Unmapped native group: catalogued but unsearchable (fails closed).
    expect(doc(m, "contractors/onboarding.md")?.aclGroups).toEqual([]);
    expect(r.unmappedAcl).toBe(1);
  });

  it("parses HTML and quarantines unsupported types", async () => {
    const m = memoryStore();
    const r = await run(m);
    const html = m.content.get(documentIdFor(source, "atlas/cutover-runbook.html"))!.text;
    expect(html).toContain("## Cutover night");
    expect(html).toContain("reconciliation run & sign-off");
    expect(html).not.toContain("console.log");
    expect(r.quarantined).toBe(1);
    expect(m.quarantined.get("atlas/architecture-diagram.pdf")).toMatchObject({ reason: "needs_ocr" });
    expect(doc(m, "atlas/architecture-diagram.pdf")).toBeUndefined();
  });

  it("is idempotent", async () => {
    const m = memoryStore();
    await run(m);
    const second = await run(m);
    expect(second).toMatchObject({ upserted: 0, tombstoned: 0, aclChanged: 0, quarantined: 0, stillQuarantined: 1 });
    expect(second.unchanged).toBe(5);
  });

  it("detects permission-only changes without re-indexing content", async () => {
    const m = memoryStore();
    await run(m);
    await writeFile(join(root, "atlas", ".acl.json"), JSON.stringify({ groups: ["SHARE\\Legal"] }));
    const r = await run(m);
    expect(r.aclChanged).toBe(2); // vendor-contacts and the runbook; legal/ has its own ACL file
    expect(doc(m, "atlas/vendor-contacts.md")?.aclGroups).toEqual(["finance-legal"]);
    expect(doc(m, "atlas/legal/settlement-notes.txt")?.aclGroups).toEqual(["finance-legal"]);
    expect(r.upserted).toBe(0);
  });

  it("re-ingests changed content and tombstones deleted files", async () => {
    const m = memoryStore();
    await run(m);
    const file = join(root, "handbook", "it-equipment-policy.md");
    await writeFile(file, "# IT equipment policy\n\n## Laptops\nLaptops are replaced every three years.\n");
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    await unlink(join(root, "atlas", "vendor-contacts.md"));
    const r = await run(m);
    expect(r.upserted).toBe(1);
    expect(m.content.get(documentIdFor(source, "handbook/it-equipment-policy.md"))!.text).toContain("three years");
    expect(r.tombstoned).toBe(1);
    expect(doc(m, "atlas/vendor-contacts.md")?.tombstoned).toBe(true);
  });

  it("never follows symlinks and fails closed on a broken ACL file", async () => {
    const m = memoryStore();
    await symlink("/etc/hosts", join(root, "handbook", "hosts.md"));
    await writeFile(join(root, "handbook", ".acl.json"), "{ not json");
    await run(m);
    expect(doc(m, "handbook/hosts.md")).toBeUndefined();
    expect(doc(m, "handbook/it-equipment-policy.md")?.aclGroups).toEqual([]);
  });

  it("releases quarantine when a bad item is fixed", async () => {
    const m = memoryStore();
    await run(m);
    await unlink(join(root, "atlas", "architecture-diagram.pdf"));
    await writeFile(join(root, "atlas", "architecture-diagram.md"), "# Architecture\n\n## Overview\nPortal, payments, migration.\n");
    await run(m);
    expect(m.quarantined.size).toBe(0);
    expect(doc(m, "atlas/architecture-diagram.md")?.aclGroups).toEqual(["atlas-team"]);
  });
});

describe("pipeline building blocks", () => {
  it("drops unmapped groups and passes through only when configured", () => {
    const s = SourceConfigSchema.parse({ id: "x-src", title: "x", kind: "folder", aclMap: { A: "a" } });
    expect(mapAcl(s, ["A", "B"])).toEqual(["a"]);
    expect(mapAcl({ ...s, aclPassThrough: true }, ["B", "A"])).toEqual(["A", "B"]);
  });

  it("creates stable, ID-safe document IDs", () => {
    const s = SourceConfigSchema.parse({ id: "x-src", title: "x", kind: "folder" });
    expect(documentIdFor(s, "a dir/file (1).md")).toBe("x-src:a_dir_file__1_.md");
    expect(documentIdFor(s, "x".repeat(300)).length).toBeLessThanOrEqual(160);
  });

  it("parses by MIME type and rejects unsupported types", () => {
    expect(parseContent("a\r\nb", "text/plain")).toBe("a\nb");
    expect(() => parseContent(new Uint8Array([37, 80, 68, 70]), "application/pdf")).toThrow(UnsupportedTypeError);
    expect(chunkText("d", "intro\n## A\none\n## B\ntwo").map((c) => c.location)).toEqual([undefined, "A", "B"]);
  });
});
