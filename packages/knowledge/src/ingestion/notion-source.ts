import type { SourceAdapter, SourceChangeSet, SourceItem } from "./types.js";

/** Fixed endpoint (no configurable URL, so no SSRF); tests inject a local fake. */
export const NOTION_API = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";
/**
 * Bump when blockToMarkdown changes: it is part of every page's version, so a
 * new conversion re-fetches each page once instead of keeping old text.
 */
const CONVERTER = "md3";

/** The native "group" for every page the integration can read; mapped with the source's aclMap (ADR 0015). */
export const NOTION_SHARED_GROUP = "notion:shared-with-integration";

type Fetch = typeof fetch;

interface RichText {
  plain_text?: string;
  href?: string | null;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

interface NotionPage {
  object: "page";
  id: string;
  url?: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, { type: string; title?: RichText[] }>;
}

/**
 * Notion as a source (ADR 0015), through an internal integration token.
 *
 * - Scope: exactly the pages someone shared with the integration in Notion
 *   ("Connections" on a page). The platform cannot see anything else.
 * - Permissions: an internal integration does not expose per-user page
 *   permissions, so every shared page gets one native group, mapped to
 *   platform groups by the source's aclMap (NOTION_ACL_GROUPS). Unmapped:
 *   unsearchable (fail closed).
 * - Change tracking: full listing each run (version = last_edited_time); a
 *   page no longer shared, archived or trashed is deleted from the index.
 * - Content: blocks converted to Markdown, nested up to 3 levels, bounded.
 *   Child pages and databases are separate items (they appear in the listing
 *   when shared), never inlined.
 */
export class NotionSourceAdapter implements SourceAdapter {
  readonly kind = "notion";

  /**
   * `token`: a fixed integration secret (NOTION_TOKEN), or a resolver for the
   * admin's "Connect Notion" connection. A resolver returning undefined means
   * "not connected": the listing is then empty and complete, so pages
   * indexed before a disconnect are removed.
   */
  constructor(
    private readonly token: string | (() => Promise<string | undefined>),
    private readonly opts: {
      baseUrl?: string;
      fetchImpl?: Fetch;
      /** Native groups given to every shared page (default: one); the source's aclMap maps each to a platform group. */
      nativeGroups?: string[];
      maxPages?: number;
      maxBlocks?: number;
      maxChars?: number;
      minIntervalMs?: number;
    } = {},
  ) {
    if (!token) throw new Error("Notion source needs a token");
  }

  private async currentToken(): Promise<string | undefined> {
    return typeof this.token === "string" ? this.token : this.token();
  }

  private last = 0;

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal, attempt = 0, token?: string): Promise<T> {
    const bearer = token ?? (await this.currentToken());
    if (!bearer) throw new Error("Notion is not connected: an admin connects it under Your connections");
    // Notion allows about 3 requests per second per integration.
    const gap = (this.opts.minIntervalMs ?? 340) - (Date.now() - this.last);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.last = Date.now();
    const res = await (this.opts.fetchImpl ?? fetch)(new URL(path, this.opts.baseUrl ?? NOTION_API), {
      method,
      headers: { authorization: `Bearer ${bearer}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(30, Number(res.headers.get("retry-after")) || 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.request(method, path, body, signal, attempt + 1, bearer);
    }
    if (res.status === 401) throw new Error(typeof this.token === "string" ? "Notion rejected the token (401): check NOTION_TOKEN" : "Notion rejected the connection (401): an admin needs to connect Notion again");
    if (!res.ok) throw new Error(`Notion ${method} ${path.split("?")[0]} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  async listChanges(_cursor: string | null, signal?: AbortSignal): Promise<SourceChangeSet> {
    const token = await this.currentToken();
    if (!token) return { full: true, cursor: new Date().toISOString(), changes: [] };
    const items: SourceItem[] = [];
    const max = this.opts.maxPages ?? 2000;
    let cursor: string | undefined;
    do {
      const r = await this.request<{ results: NotionPage[]; has_more: boolean; next_cursor: string | null }>(
        "POST",
        "/v1/search",
        { filter: { property: "object", value: "page" }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        signal,
        0,
        token,
      );
      for (const p of r.results) {
        if (p.object !== "page" || p.archived || p.in_trash) continue;
        items.push({
          externalId: p.id,
          version: `${p.last_edited_time}|${CONVERTER}`,
          title: pageTitle(p),
          url: p.url,
          modifiedAt: new Date(p.last_edited_time),
          mimeType: "text/markdown",
          // Unknown until fetched; fetchContent enforces its own bound.
          size: 0,
          acl: { groups: this.opts.nativeGroups ?? [NOTION_SHARED_GROUP] },
        });
      }
      cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
    } while (cursor && items.length < max);
    // A listing cut short by maxPages is not complete: don't let it delete the rest.
    return { full: !cursor, cursor: new Date().toISOString(), changes: items.slice(0, max).map((item) => ({ kind: "upsert" as const, item })) };
  }

  async fetchContent(item: SourceItem, signal?: AbortSignal): Promise<string> {
    const lines: string[] = [`# ${item.title}`, ""];
    let blocks = 0;
    const maxBlocks = this.opts.maxBlocks ?? 3000;
    const maxChars = this.opts.maxChars ?? 400_000;
    let chars = 0;
    const walk = async (blockId: string, depth: number) => {
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
        const r = await this.request<{ results: NotionBlock[]; has_more: boolean; next_cursor: string | null }>("GET", `/v1/blocks/${encodeURIComponent(blockId)}/children?${q}`, undefined, signal);
        for (const b of r.results) {
          if (++blocks > maxBlocks) throw new Error(`page has more than ${maxBlocks} blocks`);
          const line = blockToMarkdown(b, depth);
          if (line !== undefined) {
            lines.push(line);
            chars += line.length;
            if (chars > maxChars) throw new Error(`page text is longer than ${maxChars} characters`);
          }
          if (b.has_children && depth < 3 && b.type !== "child_page" && b.type !== "child_database") await walk(b.id, depth + 1);
        }
        cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
      } while (cursor);
    };
    await walk(item.externalId, 0);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }
}

function pageTitle(p: NotionPage): string {
  for (const prop of Object.values(p.properties ?? {})) {
    if (prop.type === "title") {
      const t = text(prop.title);
      if (t) return t.slice(0, 200);
    }
  }
  return "Untitled";
}

const text = (rt: RichText[] | undefined) => (rt ?? []).map((r) => r.plain_text ?? "").join("").trim();

/** Markdown for one block; undefined for blocks that carry no text (images, embeds, …). */
export function blockToMarkdown(b: NotionBlock, depth: number): string | undefined {
  const body = (b[b.type] ?? {}) as { rich_text?: RichText[]; checked?: boolean; language?: string; title?: string; cells?: RichText[][] };
  const t = text(body.rich_text);
  const indent = "  ".repeat(depth);
  switch (b.type) {
    case "paragraph":
      return t ? `${indent}${t}\n` : undefined;
    // The page title is the "#" line; Notion's first two heading levels both start a section ("##"),
    // which is where the platform cuts a page into passages.
    case "heading_1":
    case "heading_2":
      return `\n## ${t}\n`;
    case "heading_3":
      return `\n### ${t}\n`;
    case "bulleted_list_item":
    case "toggle":
      return `${indent}- ${t}`;
    case "numbered_list_item":
      return `${indent}1. ${t}`;
    case "to_do":
      return `${indent}- [${body.checked ? "x" : " "}] ${t}`;
    case "quote":
    case "callout":
      return t ? `${indent}> ${t}\n` : undefined;
    case "code":
      return `\n\`\`\`${body.language ?? ""}\n${t}\n\`\`\`\n`;
    case "table_row":
      return `${indent}| ${(body.cells ?? []).map((c) => text(c).replace(/\|/g, "\\|")).join(" | ")} |`;
    case "child_page":
      // A link to another page, not content: the subpage is indexed as its own document.
      return undefined;
    case "divider":
      return "\n---\n";
    default:
      return undefined;
  }
}
