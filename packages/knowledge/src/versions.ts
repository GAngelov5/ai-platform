import type { CatalogDocument } from "./types.js";

// "go-live-plan-v2.md", "spec_v3.docx", "plan v10.pdf": a base name, a version
// number, then an optional extension. File shares carry versions this way; systems
// with native versioning (SharePoint, Confluence) only expose the current one.
const VERSIONED = /^(.*?)[-_. ]v(\d{1,4})(\.[A-Za-z0-9]{1,8})?$/i;

/**
 * Superseded document -> its current version, for documents that form a
 * version family by file naming. Computed over the documents the principal may
 * read, so a newer version they cannot read is never revealed or used.
 */
export function supersededVersions(docs: readonly CatalogDocument[]): Map<string, string> {
  const families = new Map<string, { documentId: string; n: number }[]>();
  for (const d of docs) {
    const m = VERSIONED.exec(d.documentId);
    if (!m) continue;
    const key = `${d.sourceId}\u0000${m[1]!.toLowerCase()}`;
    const list = families.get(key) ?? [];
    list.push({ documentId: d.documentId, n: Number(m[2]) });
    families.set(key, list);
  }
  const out = new Map<string, string>();
  for (const list of families.values()) {
    if (list.length < 2) continue;
    const current = list.reduce((a, b) => (b.n > a.n ? b : a));
    for (const v of list) if (v.documentId !== current.documentId) out.set(v.documentId, current.documentId);
  }
  return out;
}
