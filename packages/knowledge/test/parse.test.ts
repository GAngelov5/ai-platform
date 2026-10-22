/** Isolated binary parsing on real generated corpus files. */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DOCX_MIME, ParseFailure, parseDocument, PDF_MIME } from "../src/index.js";

const corpus = (rel: string) => readFile(fileURLToPath(new URL(`../../../fixtures/sources/eval-corpus/${rel}`, import.meta.url)));

describe("parseDocument (isolated worker for binary formats)", () => {
  it("extracts PDF text", async () => {
    const text = await parseDocument(new Uint8Array(await corpus("policies/password-policy.pdf")), PDF_MIME);
    expect(text).toContain("rotated every 180 days");
  });

  it("converts DOCX headings to sections", async () => {
    const text = await parseDocument(new Uint8Array(await corpus("policies/leave-policy.docx")), DOCX_MIME);
    expect(text).toContain("## Entitlement");
    expect(text).toContain("25 days of annual leave");
  });

  it("quarantines scans without a text layer as needs_ocr", async () => {
    await expect(parseDocument(new Uint8Array(await corpus("scans/scanned-form-1.pdf")), PDF_MIME)).rejects.toMatchObject({ reason: "needs_ocr" });
  });

  it("reports corrupt files as parse errors", async () => {
    const err = await parseDocument(new TextEncoder().encode("%PDF-1.4 not really"), PDF_MIME).catch((e) => e);
    expect(err).toBeInstanceOf(ParseFailure);
    expect(err.reason).toBe("parse_error");
    const docxErr = await parseDocument(new Uint8Array([80, 75, 3, 4, 0, 0]), DOCX_MIME).catch((e) => e);
    expect(docxErr).toBeInstanceOf(ParseFailure);
  });
});
