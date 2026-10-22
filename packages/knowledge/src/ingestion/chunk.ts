export interface TextChunk {
  chunkId: string;
  location?: string;
  text: string;
}

/**
 * Splits parsed text into section chunks on "## " headings. Used identically
 * for every source, for lexical retrieval and the protected document view.
 */
export function chunkText(documentId: string, text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let heading: string | undefined;
  for (const block of text.split(/\n(?=## )/)) {
    const lines = block.split("\n");
    if (lines[0]?.startsWith("## ")) heading = lines.shift()!.slice(3).trim();
    const body = lines.join("\n").trim();
    if (body) chunks.push({ chunkId: `${documentId}#c${chunks.length + 1}`, location: heading, text: body });
  }
  return chunks;
}
