// Parses one untrusted binary document inside a worker thread (ADR 0010).
// The parent enforces a memory cap (resourceLimits) and a wall-clock timeout.
import { parentPort, workerData } from "node:worker_threads";

const { mimeType, data } = workerData;
const bytes = new Uint8Array(data);

async function run() {
  if (mimeType === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text, totalPages } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((t) => t.replace(/[ \t]+\n/g, "\n").trim());
    const chars = pages.reduce((n, p) => n + p.length, 0);
    if (chars < 20) return { ok: false, reason: "needs_ocr", detail: `${totalPages} page(s) without a text layer` };
    return { ok: true, kind: "text", value: pages.map((p, i) => (totalPages > 1 ? `## Page ${i + 1}\n${p}` : p)).join("\n\n") };
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = (await import("mammoth")).default;
    const res = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    return { ok: true, kind: "html", value: res.value };
  }
  return { ok: false, reason: "unsupported_type", detail: mimeType };
}

run().then(
  (r) => parentPort.postMessage(r),
  (err) => parentPort.postMessage({ ok: false, reason: "parse_error", detail: String(err?.message ?? err).slice(0, 300) }),
);
