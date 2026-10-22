import { Worker } from "node:worker_threads";

/** Parsers by MIME type, shared across all sources. */
export class UnsupportedTypeError extends Error {
  constructor(readonly mimeType: string) {
    super(`unsupported type ${mimeType}`);
  }
}

/** A document that could not be turned into text; the reason becomes the quarantine reason. */
export class ParseFailure extends Error {
  constructor(
    readonly reason: "needs_ocr" | "parse_error" | "parse_timeout" | "unsupported_type",
    detail?: string,
  ) {
    super(detail ?? reason);
  }
}

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const BINARY_TYPES = new Set([PDF_MIME, DOCX_MIME]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
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
  // PDF and DOCX are parsed in isolation by parseDocument(); scans need OCR (ADR 0010).
  throw new UnsupportedTypeError(mt);
}

export const SUPPORTED_MIME_TYPES = ["text/markdown", "text/plain", "text/html", PDF_MIME, DOCX_MIME] as const;

/**
 * Parses binary formats (PDF, DOCX) in a worker thread with a memory cap and a
 * timeout, so a malicious or broken file cannot exhaust or hang the worker
 * process. A stronger boundary (a separate parser container) is a production
 * hardening option (ADR 0010).
 */
export function parseBinaryIsolated(raw: Uint8Array, mimeType: string, opts: { timeoutMs?: number; maxMemoryMb?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const copy = raw.slice().buffer;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parse-worker.mjs", import.meta.url), {
      workerData: { mimeType, data: copy },
      transferList: [copy],
      resourceLimits: { maxOldGenerationSizeMb: opts.maxMemoryMb ?? 256, maxYoungGenerationSizeMb: 32 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new ParseFailure("parse_timeout", `exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    const done = () => clearTimeout(timer);
    worker.once("message", (r: { ok: boolean; kind?: "text" | "html"; value?: string; reason?: ParseFailure["reason"]; detail?: string }) => {
      done();
      void worker.terminate();
      if (r.ok) resolve(r.kind === "html" ? htmlToText(r.value ?? "") : (r.value ?? ""));
      else reject(new ParseFailure(r.reason ?? "parse_error", r.detail));
    });
    worker.once("error", (err) => {
      done();
      reject(new ParseFailure("parse_error", err.message));
    });
    worker.once("exit", (code) => {
      done();
      if (code !== 0) reject(new ParseFailure("parse_error", `parser exited with code ${code}`));
    });
  });
}

/** Any supported type to text: text formats in-process, binary formats isolated. */
export async function parseDocument(raw: string | Uint8Array, mimeType: string): Promise<string> {
  const mt = mimeType.split(";")[0]!.trim().toLowerCase();
  if (BINARY_TYPES.has(mt)) {
    if (typeof raw === "string") throw new ParseFailure("parse_error", "binary type delivered as text");
    return parseBinaryIsolated(raw, mt);
  }
  return parseContent(raw, mt);
}
