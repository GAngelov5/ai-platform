export interface TextChunk {
  chunkId: string;
  location?: string;
  text: string;
}

/**
 * Splits parsed text into section chunks on "## " headings, and long sections
 * into pieces of at most MAX_CHUNK_CHARS. Used identically
 * for every source, for lexical retrieval and the protected document view.
 */
export function chunkText(documentId: string, text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let heading: string | undefined;
  for (const block of text.split(/\n(?=## )/)) {
    const lines = block.split("\n");
    if (lines[0]?.startsWith("## ")) heading = lines.shift()!.slice(3).trim();
    const body = lines.join("\n").trim();
    for (const part of splitLong(body)) chunks.push({ chunkId: `${documentId}#c${chunks.length + 1}`, location: heading, text: part });
  }
  return chunks;
}

/**
 * Search shows at most about 1,200 characters of a chunk, so a long section is
 * split into pieces at line breaks (a single over-long line stays whole). Text
 * after the limit would otherwise never reach the assistant.
 */
export const MAX_CHUNK_CHARS = 1000;

function splitLong(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return body ? [body] : [];
  const out: string[] = [];
  let cur = "";
  for (const line of body.split("\n")) {
    if (cur && cur.length + 1 + line.length > MAX_CHUNK_CHARS) {
      out.push(cur.trim());
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
