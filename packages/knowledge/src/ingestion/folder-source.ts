import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { SourceAdapter, SourceChangeSet, SourceItem } from "./types.js";

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export const ACL_FILE = ".acl.json";

interface AclFile {
  /** Native groups allowed to read this folder (and, unless overridden, its subfolders). */
  groups: string[];
}

/**
 * A file share as a source: the template for real share adapters.
 *
 * - Permissions: a folder's `.acl.json` lists the native groups that may read
 *   it; subfolders inherit unless they have their own file (like NTFS
 *   inheritance, simplified). No ACL anywhere up the tree = no readers.
 * - Change tracking: full scan each run (version = mtime truncated to whole seconds + size;
 *   copies such as container images keep only seconds, so finer precision would
 *   re-version unchanged files).
 * - Safety: never follows symlinks; never leaves the configured root.
 */
export class FolderSourceAdapter implements SourceAdapter {
  readonly kind = "folder";

  constructor(
    private readonly root: string,
    private readonly sourceId: string,
    private readonly opts: { maxDepth?: number; maxFiles?: number } = {},
  ) {}

  private async readAcl(dir: string, inherited: string[]): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(join(dir, ACL_FILE), "utf8")) as AclFile;
      if (!Array.isArray(parsed.groups) || !parsed.groups.every((g) => typeof g === "string")) throw new Error("groups must be a string array");
      return parsed.groups;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return inherited;
      // A broken ACL file fails closed for the whole subtree.
      return [];
    }
  }

  async listChanges(): Promise<SourceChangeSet> {
    const items: SourceItem[] = [];
    const maxDepth = this.opts.maxDepth ?? 12;
    const maxFiles = this.opts.maxFiles ?? 10_000;
    const walk = async (dir: string, depth: number, inheritedAcl: string[]) => {
      if (depth > maxDepth || items.length >= maxFiles) return;
      const acl = await this.readAcl(dir, inheritedAcl);
      for (const entry of (await readdir(dir)).sort()) {
        if (entry.startsWith(".")) continue;
        const full = join(dir, entry);
        const st = await lstat(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          await walk(full, depth + 1, acl);
          continue;
        }
        if (!st.isFile()) continue;
        const rel = relative(this.root, full).split(sep).join("/");
        const mime = MIME[extname(entry).toLowerCase()] ?? "application/octet-stream";
        items.push({
          externalId: rel,
          version: `${Math.floor(st.mtimeMs / 1000) * 1000}-${st.size}`,
          title: entry.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
          url: `share://${this.sourceId}/${rel}`,
          modifiedAt: st.mtime,
          mimeType: mime,
          size: st.size,
          acl: { groups: acl },
        });
        if (items.length >= maxFiles) return;
      }
    };
    await walk(this.root, 0, []);
    return { full: true, cursor: new Date().toISOString(), changes: items.map((item) => ({ kind: "upsert" as const, item })) };
  }

  async fetchContent(item: SourceItem): Promise<Uint8Array> {
    const full = join(this.root, ...item.externalId.split("/"));
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("path escapes the source root");
    const st = await lstat(full);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("not a regular file");
    return readFile(full);
  }
}
