import { createHash } from "node:crypto";
import type { SourceAdapter, SourceChangeSet, SourceItem } from "./types.js";

/** Fixed endpoint (no configurable URL, so no SSRF); tests inject a local fake. */
export const AIRTABLE_API = "https://api.airtable.com";
/**
 * Bump when recordToText changes: it is part of every record's version, so a
 * new conversion re-indexes each record once instead of keeping old text.
 */
const CONVERTER = "at1";

/** The native "group" for every record in a granted base; mapped with the source's aclMap (ADR 0015). */
export const AIRTABLE_GRANTED_GROUP = "airtable:granted-base";
/** The native group for a base with its own groups (AIRTABLE_BASE_ACL_GROUPS). */
export const airtableBaseGroup = (baseId: string) => `airtable:base:${baseId}`;

type Fetch = typeof fetch;

interface AirtableField {
  id: string;
  name: string;
  type: string;
}
interface AirtableTable {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: AirtableField[];
}
interface AirtableRecord {
  id: string;
  createdTime: string;
  /** By field id (returnFieldsByFieldId). Empty fields are absent. */
  fields: Record<string, unknown>;
}

/** Airtable allows 5 requests per second per base. */
const PER_BASE_INTERVAL_MS = 210;

/**
 * Airtable as a source (ADR 0015 addendum), through the admin's "Connect
 * Airtable" connection.
 *
 * - Scope: exactly the bases the admin granted on Airtable's consent screen.
 * - One document per record: the title is the primary field, the text is
 *   "Field: value" lines in the table's field order. Linked records show
 *   their primary value when the linked table was listed in the same run;
 *   attachments are listed by file name and never downloaded.
 * - Change tracking: Airtable has no "modified since", so every run lists
 *   every record (100 per request). The version is a hash of the record's
 *   text, so only changed records are re-indexed, and a record missing from
 *   a complete listing is deleted from the index.
 * - Permissions: Airtable does not expose who may see a base through this
 *   API, so every granted base gets one native group per configured platform
 *   group (AIRTABLE_ACL_GROUPS, or that base's AIRTABLE_BASE_ACL_GROUPS).
 * - Limits: at most 5 requests per second per base; on 429, wait 30 seconds;
 *   a listing whose iterator expired (422) restarts from the table's start.
 */
export class AirtableSourceAdapter implements SourceAdapter {
  readonly kind = "airtable";

  constructor(
    private readonly token: string | (() => Promise<string | undefined>),
    private readonly opts: {
      baseUrl?: string;
      fetchImpl?: Fetch;
      /** Native groups for every granted base (default: one); the source's aclMap maps each to a platform group. */
      nativeGroups?: string[];
      /** Native groups for particular bases instead of nativeGroups. */
      baseNativeGroups?: Record<string, string[]>;
      maxRecords?: number;
      maxChars?: number;
      minIntervalMs?: number;
      rateLimitWaitMs?: number;
    } = {},
  ) {
    if (!token) throw new Error("Airtable source needs a token");
  }

  /** Text of the records listed by the last listChanges, by externalId: the listing already carries the content. */
  private readonly texts = new Map<string, string>();
  private readonly last = new Map<string, number>();

  private async currentToken(): Promise<string | undefined> {
    return typeof this.token === "string" ? this.token : this.token();
  }

  private async throttle(key: string) {
    const gap = (this.opts.minIntervalMs ?? PER_BASE_INTERVAL_MS) - (Date.now() - (this.last.get(key) ?? 0));
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.last.set(key, Date.now());
  }

  private async request<T>(path: string, throttleKey: string, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Resolved per request: a long run outlives an access token (one hour), and the resolver refreshes it.
      const bearer = await this.currentToken();
      if (!bearer) throw new Error("Airtable is not connected: an admin connects it under Your connections");
      await this.throttle(throttleKey);
      const res = await (this.opts.fetchImpl ?? fetch)(new URL(path, this.opts.baseUrl ?? AIRTABLE_API), {
        headers: { authorization: `Bearer ${bearer}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < 3) {
        // Airtable: wait 30 seconds before the next request.
        await new Promise((r) => setTimeout(r, this.opts.rateLimitWaitMs ?? 30_000));
        continue;
      }
      if (res.status === 422) {
        const body = (await res.json().catch(() => ({}))) as { error?: { type?: string } | string };
        const type = typeof body.error === "string" ? body.error : body.error?.type;
        if (type === "LIST_RECORDS_ITERATOR_NOT_AVAILABLE") throw new IteratorExpired();
        throw new Error(`Airtable GET ${path.split("?")[0]} failed: 422 ${String(type ?? "")}`.trim());
      }
      if (res.status === 401) throw new Error("Airtable rejected the connection (401): an admin needs to connect Airtable again");
      if (!res.ok) throw new Error(`Airtable GET ${path.split("?")[0]} failed: ${res.status}`);
      return (await res.json()) as T;
    }
  }

  async listChanges(_cursor: string | null, signal?: AbortSignal): Promise<SourceChangeSet> {
    this.texts.clear();
    if (!(await this.currentToken())) return { full: true, cursor: new Date().toISOString(), changes: [] };
    const max = this.opts.maxRecords ?? 20_000;

    const bases: { id: string; name: string }[] = [];
    let offset: string | undefined;
    do {
      const q = offset ? `?${new URLSearchParams({ offset })}` : "";
      const r = await this.request<{ bases: { id: string; name: string }[]; offset?: string }>(`/v0/meta/bases${q}`, "meta", signal);
      bases.push(...r.bases);
      offset = r.offset;
    } while (offset);

    // Listed first, rendered after: a linked record shows its primary value, which may be in a table listed later.
    const listed: { base: { id: string; name: string }; table: AirtableTable; records: AirtableRecord[] }[] = [];
    const titles = new Map<string, string>();
    let count = 0;
    let complete = true;
    outer: for (const base of bases) {
      const { tables } = await this.request<{ tables: AirtableTable[] }>(`/v0/meta/bases/${encodeURIComponent(base.id)}/tables`, base.id, signal);
      for (const table of tables) {
        const records = await this.listTable(base.id, table.id, max - count, signal);
        count += records.length;
        listed.push({ base, table, records });
        for (const rec of records) titles.set(rec.id, recordTitle(table, rec));
        if (count >= max) {
          complete = false;
          break outer;
        }
      }
    }

    const items: SourceItem[] = [];
    for (const { base, table, records } of listed) {
      const groups = this.opts.baseNativeGroups?.[base.id] ?? this.opts.nativeGroups ?? [AIRTABLE_GRANTED_GROUP];
      for (const rec of records) {
        const title = titles.get(rec.id)!;
        const text = recordToText(base.name, table, rec, title, (id) => titles.get(id)).slice(0, this.opts.maxChars ?? 200_000);
        const externalId = `${base.id}:${rec.id}`;
        this.texts.set(externalId, text);
        items.push({
          externalId,
          version: `${createHash("sha256").update(text).digest("hex").slice(0, 32)}|${CONVERTER}`,
          title,
          url: `https://airtable.com/${base.id}/${table.id}/${rec.id}`,
          modifiedAt: modifiedAt(table, rec),
          mimeType: "text/markdown",
          size: Buffer.byteLength(text),
          acl: { groups },
        });
      }
    }
    // A listing cut short by maxRecords is not complete: don't let it delete the rest.
    return { full: complete, cursor: new Date().toISOString(), changes: items.map((item) => ({ kind: "upsert" as const, item })) };
  }

  /** Every record of one table; restarts from the first page when Airtable expires the listing's iterator. */
  private async listTable(baseId: string, tableId: string, limit: number, signal?: AbortSignal): Promise<AirtableRecord[]> {
    for (let restart = 0; ; restart++) {
      const records: AirtableRecord[] = [];
      let offset: string | undefined;
      try {
        do {
          const q = new URLSearchParams({ pageSize: "100", returnFieldsByFieldId: "true", ...(offset ? { offset } : {}) });
          const r = await this.request<{ records: AirtableRecord[]; offset?: string }>(`/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${q}`, baseId, signal);
          records.push(...r.records);
          offset = r.offset;
        } while (offset && records.length < limit);
        return records.slice(0, limit);
      } catch (err) {
        if (err instanceof IteratorExpired && restart < 3) continue;
        throw err;
      }
    }
  }

  async fetchContent(item: SourceItem): Promise<string> {
    const text = this.texts.get(item.externalId);
    if (text === undefined) throw new Error("record not in the current listing");
    return text;
  }
}

class IteratorExpired extends Error {
  constructor() {
    super("Airtable listing iterator expired (LIST_RECORDS_ITERATOR_NOT_AVAILABLE)");
  }
}

function recordTitle(table: AirtableTable, rec: AirtableRecord): string {
  const primary = table.fields.find((f) => f.id === table.primaryFieldId);
  const t = primary ? cellText(primary, rec.fields[primary.id], () => undefined).replace(/\s+/g, " ").trim() : "";
  return (t || rec.id).slice(0, 200);
}

function modifiedAt(table: AirtableTable, rec: AirtableRecord): Date {
  const f = table.fields.find((x) => x.type === "lastModifiedTime");
  const v = f ? rec.fields[f.id] : undefined;
  const d = new Date(typeof v === "string" ? v : rec.createdTime);
  return Number.isNaN(d.getTime()) ? new Date(rec.createdTime) : d;
}

/**
 * Markdown for one record: the title, where it lives, then "Field: value"
 * in the table's field order. Empty fields are left out. Nothing that
 * changes on its own (attachment URLs expire after a few hours) goes in,
 * so the text, and the version hashed from it, change only with the record.
 */
export function recordToText(baseName: string, table: AirtableTable, rec: AirtableRecord, title: string, linked: (recordId: string) => string | undefined): string {
  const lines = [`# ${title}`, "", `Airtable base "${baseName}", table "${table.name}"`, ""];
  for (const f of table.fields) {
    if (f.id === table.primaryFieldId) continue;
    const v = cellText(f, rec.fields[f.id], linked).trim();
    if (!v) continue;
    lines.push(v.includes("\n") ? `${f.name}:\n${v}\n` : `${f.name}: ${v}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** One cell as text; "" for an empty cell or a value without readable text. */
export function cellText(field: Pick<AirtableField, "type">, v: unknown, linked: (recordId: string) => string | undefined): string {
  if (v === undefined || v === null) return "";
  switch (field.type) {
    case "checkbox":
      return v === true ? "Yes" : "";
    case "multipleRecordLinks":
      return Array.isArray(v) ? v.map((id) => (typeof id === "string" ? (linked(id) ?? id) : "")).filter(Boolean).join(", ") : "";
    case "multipleAttachments":
      return Array.isArray(v) ? v.map((a) => String((a as { filename?: unknown }).filename ?? "")).filter(Boolean).join(", ") : "";
    default:
      return plain(v);
  }
}

/** Any other value: strings, numbers, lists, and the readable part of objects (collaborators, barcodes, AI text, buttons). */
function plain(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "Yes" : "";
  if (Array.isArray(v)) return v.map(plain).filter(Boolean).join(", ");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Lookups of attachments carry a filename; never a URL (they expire and aren't content).
    for (const k of ["name", "filename", "text", "value", "label"]) if (typeof o[k] === "string" || typeof o[k] === "number") return String(o[k]);
  }
  return "";
}
