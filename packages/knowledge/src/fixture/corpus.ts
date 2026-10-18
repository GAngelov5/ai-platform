import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface FixtureChunk {
  chunkId: string;
  location?: string;
  text: string;
}

export interface FixtureDocument {
  documentId: string;
  sourceId: string;
  version: string;
  title: string;
  aclGroups: string[];
  indexedAt: Date;
  sourceUrl?: string;
  body: string;
  contentHash: string;
  fileName: string;
  chunks: FixtureChunk[];
}

const REQUIRED = ["documentId", "sourceId", "version", "title", "acl", "indexedAt"] as const;

export function parseFixtureDocument(fileName: string, raw: string): FixtureDocument {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`${fileName}: missing front matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const k of REQUIRED) if (!meta[k]) throw new Error(`${fileName}: front matter field "${k}" is required`);
  const indexedAt = new Date(meta.indexedAt!);
  if (Number.isNaN(indexedAt.getTime())) throw new Error(`${fileName}: invalid indexedAt`);
  const body = m[2]!.trim();
  const documentId = meta.documentId!;

  const chunks: FixtureChunk[] = [];
  let heading: string | undefined;
  for (const block of body.split(/\n(?=## )/)) {
    const lines = block.split("\n");
    if (lines[0]?.startsWith("## ")) heading = lines.shift()!.slice(3).trim();
    const text = lines.join("\n").trim();
    if (text) chunks.push({ chunkId: `${documentId}#c${chunks.length + 1}`, location: heading, text });
  }

  return {
    documentId,
    sourceId: meta.sourceId!,
    version: meta.version!,
    title: meta.title!,
    aclGroups: meta.acl!.split(",").map((s) => s.trim()).filter(Boolean),
    indexedAt,
    sourceUrl: meta.sourceUrl,
    body,
    contentHash: createHash("sha256").update(raw).digest("hex"),
    fileName,
    chunks,
  };
}

export async function loadFixtureCorpus(dir: string): Promise<FixtureDocument[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const docs = await Promise.all(files.map(async (f) => parseFixtureDocument(f, await readFile(join(dir, f), "utf8"))));
  const ids = new Set<string>();
  for (const d of docs) {
    if (ids.has(d.documentId)) throw new Error(`duplicate fixture documentId ${d.documentId}`);
    ids.add(d.documentId);
  }
  return docs;
}
