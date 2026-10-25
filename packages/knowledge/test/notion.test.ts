/**
 * Notion source (ADR 0015): the real NotionSourceAdapter and the generic
 * ingestion pipeline against a local fake of the Notion API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  adapterFor,
  blockToMarkdown,
  defaultSources,
  ingestSource,
  NOTION_SHARED_GROUP,
  NotionSourceAdapter,
  type CatalogDocument,
  type IngestionStore,
} from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const C = "cust_demo";
const TOKEN = "secret_test_notion_token";

const rt = (t: string) => ({ rich_text: [{ plain_text: t }] });
type Page = { id: string; title: string; edited: string; archived?: boolean; blocks: Record<string, unknown>[] };
let pages: Page[];
const children: Record<string, Record<string, unknown>[]> = {};
const requests: string[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const json = (s: number, b: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { code: "unauthorized" });
    if (req.headers["notion-version"] !== "2022-06-28") return json(400, { code: "missing_version" });
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/v1/search") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { start_cursor?: string };
      // Two results per page of the listing, to exercise pagination.
      const start = Number(body.start_cursor ?? 0);
      const slice = pages.slice(start, start + 2);
      return json(200, {
        results: slice.map((p) => ({
          object: "page",
          id: p.id,
          url: `https://www.notion.so/${p.id}`,
          last_edited_time: p.edited,
          archived: !!p.archived,
          properties: { Name: { type: "title", title: [{ plain_text: p.title }] } },
        })),
        has_more: start + 2 < pages.length,
        next_cursor: start + 2 < pages.length ? String(start + 2) : null,
      });
    }
    const m = /^\/v1\/blocks\/([^/]+)\/children$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const id = decodeURIComponent(m[1]!);
      const blocks = pages.find((p) => p.id === id)?.blocks ?? children[id] ?? [];
      return json(200, { results: blocks, has_more: false, next_cursor: null });
    }
    json(404, {});
  });
  base = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
});
afterAll(() => server?.close());

beforeEach(() => {
  requests.length = 0;
  children["b-toggle"] = [{ id: "b-inner", type: "paragraph", ...{ paragraph: rt("Nested detail: the vendor is Northwind Logistics.") } }];
  pages = [
    {
      id: "p-roadmap",
      title: "Product roadmap 2027",
      edited: "2026-10-20T10:00:00.000Z",
      blocks: [
        { id: "b1", type: "heading_1", heading_1: rt("Q1 goals") },
        { id: "b2", type: "bulleted_list_item", bulleted_list_item: rt("Launch the customer portal in February") },
        { id: "b3", type: "to_do", to_do: { ...rt("Hire two engineers"), checked: true } },
        { id: "b-toggle", type: "toggle", has_children: true, toggle: rt("Vendors") },
        { id: "b4", type: "image", image: {} },
        { id: "b5", type: "code", code: { ...rt("SELECT 1"), language: "sql" } },
      ],
    },
    { id: "p-notes", title: "Meeting notes", edited: "2026-10-21T10:00:00.000Z", blocks: [{ id: "n1", type: "paragraph", paragraph: rt("Decided to move the launch to March.") }] },
    { id: "p-old", title: "Archived page", edited: "2026-01-01T00:00:00.000Z", archived: true, blocks: [] },
  ];
});

function memoryStore() {
  const catalog = new Map<string, CatalogDocument>();
  const content = new Map<string, { version: string; contentHash: string; text: string }>();
  const quarantined = new Map<string, string>();
  const store: IngestionStore = {
    listCatalog: async () => [...catalog.values()],
    upsertCatalog: async (d) => void catalog.set(d.documentId, { ...d, aclRevision: 1, tombstoned: false }),
    setAcl: async (_c, id, acl) => void catalog.set(id, { ...catalog.get(id)!, aclGroups: acl }),
    tombstone: async (_c, id) => void catalog.set(id, { ...catalog.get(id)!, tombstoned: true }),
    getContent: async (_c, id) => content.get(id),
    putContent: async (r) => void content.set(r.documentId, r),
    getState: async () => undefined,
    saveState: async () => {},
    quarantine: async (r) => void quarantined.set(r.externalId, r.reason),
    release: async (_c, _s, id) => void quarantined.delete(id),
    listQuarantined: async () => [],
  };
  return { store, catalog, content, quarantined };
}

const notionSource = (groups = ["all-staff"]) => {
  const s = defaultSources(FIXTURES, { notion: { aclGroups: groups } }).find((x) => x.id === "notion")!;
  return { ...s, settings: { ...s.settings, baseUrl: base } };
};
const secret = (n: string) => (n === "NOTION_TOKEN" ? TOKEN : undefined);

describe("Notion source adapter", () => {
  it("lists every shared page across result pages, skipping archived ones", async () => {
    const a = new NotionSourceAdapter(TOKEN, { baseUrl: base, minIntervalMs: 0 });
    const r = await a.listChanges(null);
    expect(r.full).toBe(true);
    expect(r.changes.map((c) => (c.kind === "upsert" ? [c.item.externalId, c.item.title, c.item.version] : []))).toEqual([
      ["p-roadmap", "Product roadmap 2027", "2026-10-20T10:00:00.000Z|md3"],
      ["p-notes", "Meeting notes", "2026-10-21T10:00:00.000Z|md3"],
    ]);
    expect(requests.filter((x) => x.startsWith("POST /v1/search"))).toHaveLength(2);
  });

  it("converts blocks to Markdown, including nested ones, and skips blocks without text", async () => {
    const a = new NotionSourceAdapter(TOKEN, { baseUrl: base, minIntervalMs: 0 });
    const first = (await a.listChanges(null)).changes[0];
    if (first?.kind !== "upsert") throw new Error("expected an upsert");
    const md = await a.fetchContent(first.item);
    expect(md).toContain("# Product roadmap 2027");
    expect(md).toContain("\n## Q1 goals");
    expect(md).toContain("- Launch the customer portal in February");
    expect(md).toContain("- [x] Hire two engineers");
    expect(md).toContain("  Nested detail: the vendor is Northwind Logistics.");
    expect(md).toContain("```sql\nSELECT 1\n```");
  });

  it("starts a section (a search passage) at Notion's first two heading levels", () => {
    expect(blockToMarkdown({ id: "h1", type: "heading_1", heading_1: rt("Budget") }, 0)).toBe("\n## Budget\n");
    expect(blockToMarkdown({ id: "h2", type: "heading_2", heading_2: rt("Risks") }, 0)).toBe("\n## Risks\n");
    expect(blockToMarkdown({ id: "h3", type: "heading_3", heading_3: rt("Detail") }, 0)).toBe("\n### Detail\n");
  });

  it("doesn't turn links to subpages into text (each subpage is its own document)", () => {
    expect(blockToMarkdown({ id: "c", type: "child_page", child_page: { title: "Project Orion" } }, 0)).toBeUndefined();
  });

  it("refuses a wrong token with a clear message", async () => {
    const a = new NotionSourceAdapter("wrong", { baseUrl: base, minIntervalMs: 0 });
    await expect(a.listChanges(null)).rejects.toThrow(/check NOTION_TOKEN/);
  });

  it("a listing cut short by maxPages is not treated as complete (nothing gets deleted)", async () => {
    const a = new NotionSourceAdapter(TOKEN, { baseUrl: base, minIntervalMs: 0, maxPages: 1 });
    expect((await a.listChanges(null)).full).toBe(false);
  });

  it("is only configured with a token resolved by reference", () => {
    expect(() => adapterFor(notionSource(), { secret: () => undefined })).toThrow(/needs NOTION_TOKEN/);
    expect(notionSource().settings).not.toHaveProperty("token");
  });
});

describe("Notion through the ingestion pipeline", () => {
  it("indexes shared pages readable by the configured groups, and deletes pages no longer shared", async () => {
    const { store, catalog, content } = memoryStore();
    const source = notionSource(["all-staff", "atlas-team"]);
    const adapter = adapterFor(source, { secret });
    await ingestSource(C, source, adapter, store, () => {});
    const docs = [...catalog.values()];
    expect(docs.map((d) => [d.documentId, d.title, d.aclGroups])).toEqual([
      ["notion:p-roadmap", "Product roadmap 2027", ["all-staff", "atlas-team"]],
      ["notion:p-notes", "Meeting notes", ["all-staff", "atlas-team"]],
    ]);
    expect(content.get("notion:p-notes")!.text).toContain("Decided to move the launch to March.");

    // Unshared in Notion: gone from the listing, so tombstoned here.
    pages = pages.filter((p) => p.id !== "p-notes");
    await ingestSource(C, source, adapterFor(source, { secret }), store, () => {});
    expect(catalog.get("notion:p-notes")!.tombstoned).toBe(true);
    expect(catalog.get("notion:p-roadmap")!.tombstoned).toBe(false);
  });

  it("an unchanged page is not fetched again", async () => {
    const { store } = memoryStore();
    const source = notionSource();
    await ingestSource(C, source, adapterFor(source, { secret }), store, () => {});
    requests.length = 0;
    await ingestSource(C, source, adapterFor(source, { secret }), store, () => {});
    expect(requests.filter((r) => r.includes("/children"))).toEqual([]);
  });

  it("maps every shared page to one native group per platform group", () => {
    const s = notionSource(["all-staff", "finance-legal"]);
    expect(s.aclMap).toEqual({ [NOTION_SHARED_GROUP]: "all-staff", [`${NOTION_SHARED_GROUP}#1`]: "finance-legal" });
  });

  it("with Connect Notion: uses the connection's token, and removes every page once disconnected", async () => {
    const { store, catalog } = memoryStore();
    const base0 = defaultSources(FIXTURES, { notion: { aclGroups: ["all-staff"], viaConnection: true } }).find((x) => x.id === "notion")!;
    const source = { ...base0, settings: { ...base0.settings, baseUrl: base } };
    expect(source.settings).toMatchObject({ tokenFrom: "connection" });
    expect(() => adapterFor(source, {})).toThrow(/connection store/);
    let connected: string | undefined = TOKEN;
    const opts = { notionConnection: async () => connected };
    await ingestSource(C, source, adapterFor(source, opts), store, () => {});
    expect([...catalog.values()].filter((d) => !d.tombstoned)).toHaveLength(2);
    connected = undefined; // the admin disconnected Notion
    await ingestSource(C, source, adapterFor(source, opts), store, () => {});
    expect([...catalog.values()].every((d) => d.tombstoned)).toBe(true);
  });
});
