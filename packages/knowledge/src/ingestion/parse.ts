/** Parsers by MIME type, shared across all sources. */
export class UnsupportedTypeError extends Error {
  constructor(readonly mimeType: string) {
    super(`unsupported type ${mimeType}`);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h[1-2][^>]*>([\s\S]*?)<\/h[1-2]>/gi, (_m, t: string) => `\n## ${t.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<\/(p|div|li|h[3-6]|tr|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const asText = (raw: string | Uint8Array) => (typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: false }).decode(raw));

/** Returns plain text with "## " section headings, or throws UnsupportedTypeError. */
export function parseContent(raw: string | Uint8Array, mimeType: string): string {
  const mt = mimeType.split(";")[0]!.trim().toLowerCase();
  if (mt === "text/markdown" || mt === "text/plain") return asText(raw).replace(/\r\n/g, "\n").trim();
  if (mt === "text/html") return htmlToText(asText(raw));
  // PDF, DOCX and scans need a document parser (ADR 0009, open question).
  throw new UnsupportedTypeError(mt);
}

export const SUPPORTED_MIME_TYPES = ["text/markdown", "text/plain", "text/html"] as const;
