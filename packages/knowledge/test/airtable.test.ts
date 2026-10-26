/**
 * Airtable source (ADR 0015 addendum): the real AirtableSourceAdapter and the
 * generic ingestion pipeline against a local fake of the Airtable API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  adapterFor,
  AIRTABLE_GRANTED_GROUP,
  AirtableSourceAdapter,
  cellText,
  defaultSources,
  ingestSource,
  type CatalogDocument,
  type IngestionStore,
  type SourceItem,
} from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const C = "cust_demo";
const TOKEN = "atat-test-token";
const SALES = "appSales000000001";
const HR = "appPeople00000002";

type Rec = { id: string; createdTime: string; fields: Record<string, unknown> };
type Table = { id: string; name: string; primaryFieldId: string; fields: { id: string; name: string; type: string }[]; records: Rec[] };
let bases: { id: string; name: string; tables: Table[] }[];
const requests: { at: number; path: string }[] = [];
/** Failures to inject: the next request whose path matches answers with this status (once each). */
let inject: { match: RegExp; status: number; body?: unknown }[] = [];
let server: Server;
let base: string;
/** Records per page in the fake (Airtable: up to 100), small to exercise paging. */
const PAGE = 2;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ at: Date.now(), path: url.pathname + url.search });
    const json = (s: number, b: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { type: "AUTHENTICATION_REQUIRED" } });
    const i = inject.findIndex((x) => x.match.test(url.pathname + url.search));
    if (i >= 0) {
      const [f] = inject.splice(i, 1);
      return json(f!.status, f!.body ?? {});
    }
    if (url.pathname === "/v0/meta/bases") {
      // One base per page, to exercise the bases listing's offset too.
      const start = Number(url.searchParams.get("offset") ?? 0);
      return json(200, { bases: bases.slice(start, start + 1).map(({ id, name }) => ({ id, name, permissionLevel: "read" })), ...(start + 1 < bases.length ? { offset: String(start + 1) } : {}) });
    }
    const meta = /^\/v0\/meta\/bases\/([^/]+)\/tables$/.exec(url.pathname);
    if (meta) {
      const b = bases.find((x) => x.id === meta[1]);
      if (!b) return json(404, { error: "NOT_FOUND" });
      return json(200, { tables: b.tables.map(({ records: _r, ...t }) => t) });
    }
    const list = /^\/v0\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (list) {
      if (url.searchParams.get("returnFieldsByFieldId") !== "true") return json(400, { error: "expected field ids" });
      const t = bases.find((x) => x.id === list[1])?.tables.find((x) => x.id === list[2]);
      if (!t) return json(404, { error: "NOT_FOUND" });
      const start = Number(url.searchParams.get("offset") ?? 0);
      const end = start + Math.min(PAGE, Number(url.searchParams.get("pageSize") ?? 100));
      return json(200, { records: t.records.slice(start, end), ...(end < t.records.length ? { offset: String(end) } : {}) });
    }
    json(404, {});
  });
  base = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
});
afterAll(() => server?.close());

const att = (name: string, n: number) => ({ id: `att${n}`, url: `https://v5.airtableusercontent.com/${n}/${Date.now()}`, filename: name, size: 1000, type: "application/pdf" });

beforeEach(() => {
  requests.length = 0;
  inject = [];
  bases = [
    {
      id: SALES,
      name: "Sales CRM",
      tables: [
        {
          id: "tblCustomers",
          name: "Customers",
          primaryFieldId: "fldName",
          fields: [
            { id: "fldName", name: "Name", type: "singleLineText" },
            { id: "fldTier", name: "Tier", type: "singleSelect" },
            { id: "fldOwner", name: "Account owner", type: "singleCollaborator" },
            { id: "fldNotes", name: "Notes", type: "multilineText" },
          ],
          records: [
            { id: "recNorthwind", createdTime: "2026-09-01T08:00:00.000Z", fields: { fldName: "Northwind Logistics", fldTier: "Gold", fldOwner: { id: "usr1", email: "maria@example.test", name: "Maria Petrova" }, fldNotes: "Renewal in March.\nPrefers email." } },
            { id: "recContoso", createdTime: "2026-09-02T08:00:00.000Z", fields: { fldName: "Contoso Retail", fldTier: "Silver" } },
            { id: "recFabrikam", createdTime: "2026-09-03T08:00:00.000Z", fields: { fldName: "Fabrikam Foods" } },
          ],
        },
        {
          id: "tblDeals",
          name: "Deals",
          primaryFieldId: "fldDeal",
          fields: [
            { id: "fldDeal", name: "Deal", type: "singleLineText" },
            { id: "fldAmount", name: "Amount (EUR)", type: "currency" },
            { id: "fldCustomer", name: "Customer", type: "multipleRecordLinks" },
            { id: "fldSigned", name: "Signed", type: "checkbox" },
            { id: "fldFiles", name: "Contract", type: "multipleAttachments" },
            { id: "fldStage", name: "Stage", type: "singleSelect" },
          ],
          records: [
            { id: "recDeal1", createdTime: "2026-10-01T08:00:00.000Z", fields: { fldDeal: "Northwind 2027 renewal", fldAmount: 48000, fldCustomer: ["recNorthwind"], fldSigned: true, fldFiles: [att("northwind-msa.pdf", 1)], fldStage: "Negotiation" } },
            { id: "recDeal2", createdTime: "2026-10-02T08:00:00.000Z", fields: { fldAmount: 12000, fldCustomer: ["recContoso", "recUnknown"] } },
          ],
        },
      ],
    },
    {
      id: HR,
      name: "People",
      tables: [
        {
          id: "tblStaff",
          name: "Staff",
          primaryFieldId: "fldPerson",
          fields: [
            { id: "fldPerson", name: "Person", type: "singleLineText" },
            { id: "fldSalary", name: "Salary band", type: "singleSelect" },
          ],
          records: [{ id: "recIvan", createdTime: "2026-08-01T08:00:00.000Z", fields: { fldPerson: "Ivan Georgiev", fldSalary: "B3" } }],
        },
      ],
    },
  ];
});

const adapter = (opts: ConstructorParameters<typeof AirtableSourceAdapter>[1] = {}) => new AirtableSourceAdapter(TOKEN, { baseUrl: base, minIntervalMs: 0, rateLimitWaitMs: 10, ...opts });
const upserts = (r: Awaited<ReturnType<AirtableSourceAdapter["listChanges"]>>) => r.changes.flatMap((c) => (c.kind === "upsert" ? [c.item] : []));
const byId = (items: SourceItem[], id: string) => items.find((i) => i.externalId.endsWith(`:${id}`))!;

describe("Airtable source adapter", () => {
  it("lists every record of every granted base and table, across pages, as one item each", async () => {
    const r = await adapter().listChanges(null);
    expect(r.full).toBe(true);
    const items = upserts(r);
    expect(items.map((i) => [i.externalId, i.title])).toEqual([
      [`${SALES}:recNorthwind`, "Northwind Logistics"],
      [`${SALES}:recContoso`, "Contoso Retail"],
      [`${SALES}:recFabrikam`, "Fabrikam Foods"],
      [`${SALES}:recDeal1`, "Northwind 2027 renewal"],
      // No primary value: the record id.
      [`${SALES}:recDeal2`, "recDeal2"],
      [`${HR}:recIvan`, "Ivan Georgiev"],
    ]);
    expect(byId(items, "recDeal1")).toMatchObject({ url: `https://airtable.com/${SALES}/tblDeals/recDeal1`, mimeType: "text/markdown", acl: { groups: [AIRTABLE_GRANTED_GROUP] } });
    expect(byId(items, "recDeal1").version).toMatch(/^[0-9a-f]{32}\|at1$/);
    // Customers: 3 records at 2 per page.
    expect(requests.filter((x) => x.path.startsWith(`/v0/${SALES}/tblCustomers`))).toHaveLength(2);
    expect(requests.filter((x) => x.path.startsWith("/v0/meta/bases?") || x.path === "/v0/meta/bases")).toHaveLength(2);
  });

  it("writes 'Field: value' lines in field order, resolving linked records and naming attachments without their URLs", async () => {
    const a = adapter();
    const items = upserts(await a.listChanges(null));
    const deal = await a.fetchContent(byId(items, "recDeal1"));
    expect(deal).toBe(
      [
        "# Northwind 2027 renewal",
        "",
        'Airtable base "Sales CRM", table "Deals"',
        "",
        "Amount (EUR): 48000",
        "Customer: Northwind Logistics",
        "Signed: Yes",
        "Contract: northwind-msa.pdf",
        "Stage: Negotiation",
        "",
      ].join("\n"),
    );
    expect(deal).not.toContain("airtableusercontent");
    // A link to a record that wasn't listed keeps its id.
    expect(await a.fetchContent(byId(items, "recDeal2"))).toContain("Customer: Contoso Retail, recUnknown");
    const customer = await a.fetchContent(byId(items, "recNorthwind"));
    expect(customer).toContain("Tier: Gold\nAccount owner: Maria Petrova\nNotes:\nRenewal in March.\nPrefers email.\n");
    // Empty fields are left out.
    expect(await a.fetchContent(byId(items, "recFabrikam"))).not.toContain("Tier:");
  });

  it("renders the readable part of other cell types", () => {
    const none = () => undefined;
    expect(cellText({ type: "multipleSelects" }, ["EU", "Retail"], none)).toBe("EU, Retail");
    expect(cellText({ type: "checkbox" }, false, none)).toBe("");
    expect(cellText({ type: "barcode" }, { text: "4006381333931" }, none)).toBe("4006381333931");
    expect(cellText({ type: "aiText" }, { state: "generated", value: "Likely to renew" }, none)).toBe("Likely to renew");
    expect(cellText({ type: "multipleLookupValues" }, [{ filename: "a.pdf", url: "https://x" }], none)).toBe("a.pdf");
    expect(cellText({ type: "rollup" }, { unexpected: { url: "https://x" } }, none)).toBe("");
  });

  it("the version changes only when the record's text changes, not when attachment URLs are re-signed", async () => {
    const v1 = byId(upserts(await adapter().listChanges(null)), "recDeal1").version;
    const deal = bases[0]!.tables[1]!.records[0]!;
    deal.fields.fldFiles = [att("northwind-msa.pdf", 1)].map((a) => ({ ...a, url: "https://v5.airtableusercontent.com/resigned" }));
    expect(byId(upserts(await adapter().listChanges(null)), "recDeal1").version).toBe(v1);
    deal.fields.fldStage = "Closed won";
    expect(byId(upserts(await adapter().listChanges(null)), "recDeal1").version).not.toBe(v1);
    // A renamed linked customer changes the deal's text too.
    const v2 = byId(upserts(await adapter().listChanges(null)), "recDeal1").version;
    bases[0]!.tables[0]!.records[0]!.fields.fldName = "Northwind Logistics AD";
    expect(byId(upserts(await adapter().listChanges(null)), "recDeal1").version).not.toBe(v2);
  });

  it("waits and retries after a 429", async () => {
    inject = [{ match: /\/tblDeals/, status: 429, body: { errors: [{ error: "RATE_LIMIT_REACHED" }] } }];
    const started = Date.now();
    const items = upserts(await adapter({ rateLimitWaitMs: 60 }).listChanges(null));
    expect(items).toHaveLength(6);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(requests.filter((x) => x.path.startsWith(`/v0/${SALES}/tblDeals`))).toHaveLength(2);
  });

  it("fails the run (keeping the index as it is) when Airtable keeps answering 429", async () => {
    inject = Array.from({ length: 4 }, () => ({ match: /\/tblDeals/, status: 429 }));
    await expect(adapter().listChanges(null)).rejects.toThrow(/429/);
  });

  it("restarts a table's listing when its iterator expires (422), without duplicates", async () => {
    inject = [{ match: /\/tblCustomers\?.*offset=2/, status: 422, body: { error: { type: "LIST_RECORDS_ITERATOR_NOT_AVAILABLE" } } }];
    const items = upserts(await adapter().listChanges(null));
    expect(items.filter((i) => i.externalId.includes("recNorthwind"))).toHaveLength(1);
    expect(items).toHaveLength(6);
    // first page, failed second page, then from the start: two pages.
    expect(requests.filter((x) => x.path.startsWith(`/v0/${SALES}/tblCustomers`)).map((x) => new URL(x.path, "http://x").searchParams.get("offset"))).toEqual([null, "2", null, "2"]);
  });

  it("other 422s are errors", async () => {
    inject = [{ match: /\/tblStaff/, status: 422, body: { error: { type: "INVALID_REQUEST_UNKNOWN" } } }];
    await expect(adapter().listChanges(null)).rejects.toThrow(/422 INVALID_REQUEST_UNKNOWN/);
  });

  it("keeps to the per-base request rate", async () => {
    await adapter({ minIntervalMs: 40 }).listChanges(null);
    const sales = requests.filter((x) => x.path.includes(SALES)).map((x) => x.at);
    const gaps = sales.slice(1).map((t, i) => t - sales[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(35);
  });

  it("a listing cut short by maxRecords is not complete (nothing gets deleted)", async () => {
    const r = await adapter({ maxRecords: 3 }).listChanges(null);
    expect(r.full).toBe(false);
    expect(upserts(r)).toHaveLength(3);
  });

  it("refuses a rejected connection with a clear message", async () => {
    await expect(new AirtableSourceAdapter("wrong", { baseUrl: base, minIntervalMs: 0 }).listChanges(null)).rejects.toThrow(/connect Airtable again/);
  });
});

function memoryStore() {
  const catalog = new Map<string, CatalogDocument>();
  const content = new Map<string, { version: string; contentHash: string; text: string }>();
  const store: IngestionStore = {
    listCatalog: async () => [...catalog.values()],
    upsertCatalog: async (d) => void catalog.set(d.documentId, { ...d, aclRevision: 1, tombstoned: false }),
    setAcl: async (_c, id, acl) => void catalog.set(id, { ...catalog.get(id)!, aclGroups: acl }),
    tombstone: async (_c, id) => void catalog.set(id, { ...catalog.get(id)!, tombstoned: true }),
    getContent: async (_c, id) => content.get(id),
    putContent: async (r) => void content.set(r.documentId, r),
    getState: async () => undefined,
    saveState: async () => {},
    quarantine: async () => {},
    release: async () => {},
    listQuarantined: async () => [],
  };
  return { store, catalog, content };
}

const airtableSource = (groups = ["all-staff"], baseAclGroups?: Record<string, string[]>) => {
  const s = defaultSources(FIXTURES, { airtable: { aclGroups: groups, baseAclGroups } }).find((x) => x.id === "airtable")!;
  return { ...s, settings: { ...s.settings, baseUrl: base } };
};

describe("Airtable through the ingestion pipeline", () => {
  let connected: string | undefined;
  const opts = { airtableConnection: async () => connected };
  beforeEach(() => {
    connected = TOKEN;
  });

  it("is only configured through the connection", () => {
    expect(airtableSource().settings).toMatchObject({ tokenFrom: "connection" });
    expect(() => adapterFor(airtableSource(), {})).toThrow(/Airtable connection store/);
  });

  it("indexes every record readable only by the configured groups; a base override gets its own groups", async () => {
    const { store, catalog, content } = memoryStore();
    const source = airtableSource(["all-staff", "atlas-team"], { [HR]: ["finance-legal"] });
    expect(source.aclMap).toEqual({
      [AIRTABLE_GRANTED_GROUP]: "all-staff",
      [`${AIRTABLE_GRANTED_GROUP}#1`]: "atlas-team",
      [`airtable:base:${HR}`]: "finance-legal",
    });
    const r = await ingestSource(C, source, adapterFor(source, opts), store, () => {});
    expect(r).toMatchObject({ upserted: 6, unmappedAcl: 0 });
    expect(catalog.get(`airtable:${SALES}:recDeal1`)).toMatchObject({ title: "Northwind 2027 renewal", aclGroups: ["all-staff", "atlas-team"], sourceUrl: `https://airtable.com/${SALES}/tblDeals/recDeal1` });
    expect(catalog.get(`airtable:${HR}:recIvan`)!.aclGroups).toEqual(["finance-legal"]);
    expect(content.get(`airtable:${SALES}:recDeal1`)!.text).toContain("Customer: Northwind Logistics");
  });

  it("re-indexes only changed records, and deletes records missing from the full listing", async () => {
    const { store, catalog } = memoryStore();
    const source = airtableSource();
    await ingestSource(C, source, adapterFor(source, opts), store, () => {});
    bases[0]!.tables[0]!.records = bases[0]!.tables[0]!.records.filter((r) => r.id !== "recFabrikam");
    bases[1]!.tables[0]!.records[0]!.fields.fldSalary = "B4";
    const r = await ingestSource(C, source, adapterFor(source, opts), store, () => {});
    expect(r).toMatchObject({ upserted: 1, unchanged: 4, tombstoned: 1 });
    expect(catalog.get(`airtable:${SALES}:recFabrikam`)!.tombstoned).toBe(true);
  });

  it("removes every record once disconnected", async () => {
    const { store, catalog } = memoryStore();
    const source = airtableSource();
    await ingestSource(C, source, adapterFor(source, opts), store, () => {});
    connected = undefined;
    await ingestSource(C, source, adapterFor(source, opts), store, () => {});
    expect([...catalog.values()].every((d) => d.tombstoned)).toBe(true);
  });
});
