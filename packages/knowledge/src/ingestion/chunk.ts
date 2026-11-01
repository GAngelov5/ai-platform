export interface TextChunk {
  chunkId: string;
  location?: string;
  text: string;
}

/**
 * Splits parsed text into section chunks on "## " headings, and long sections
 * into pieces of at most MAX_CHUNK_CHARS. Used identically
 * for every source, for lexical retrieval and the protected document view.
 *
 * A leading "# " document heading ("Ember go-live plan (version 2, current)")
 * is context for every section, so it becomes part of each chunk's location
 * ("Ember go-live plan (version 2, current) › Go-live") instead of a chunk of
 * its own with no facts. Chunk ids keep their numbering, so ids that were
 * issued or indexed before stay valid.
 */
export function chunkText(documentId: string, text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let n = 0;
  let heading: string | undefined;
  let title: string | undefined;
  const at = () => (title && heading ? `${title} › ${heading}` : (heading ?? title));
  for (const [i, block] of text.split(/\n(?=## )/).entries()) {
    const lines = block.split("\n");
    if (i === 0) {
      const first = lines.findIndex((l) => l.trim() !== "");
      if (first >= 0 && /^# \S/.test(lines[first]!)) {
        title = lines[first]!.slice(2).trim().slice(0, 200);
        lines.splice(first, 1);
        // The heading alone was a chunk before: keep its number so later ids don't shift.
        if (lines.join("\n").trim() === "") n++;
      }
    }
    if (lines[0]?.startsWith("## ")) heading = lines.shift()!.slice(3).trim();
    const body = lines.join("\n").trim();
    for (const part of splitLong(body)) chunks.push({ chunkId: `${documentId}#c${++n}`, location: at(), text: part });
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
