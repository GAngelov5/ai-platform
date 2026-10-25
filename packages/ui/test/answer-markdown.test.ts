import { describe, expect, it } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { AnswerMarkdown, parseAnswer } from "../src/AnswerMarkdown.js";

/** Flattens a rendered element tree into [tag, text] pairs, and fails on any raw-HTML injection. */
function walk(node: ReactNode, out: [string, string][] = [], tag = "text"): [string, string][] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") return out.push([tag, String(node)]), out;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, out, tag)), out;
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; dangerouslySetInnerHTML?: unknown };
    expect(props.dangerouslySetInnerHTML).toBeUndefined();
    const t = typeof node.type === "string" ? node.type : tag;
    return walk(props.children, out, t);
  }
  return out;
}
const render = (text: string) => walk(AnswerMarkdown({ text, cite: (id) => `[cite:${id}]` }));

describe("answer Markdown", () => {
  it("turns a Gemini-style answer into a paragraph and a list, citations kept", () => {
    const text = "The Orion field pilot starts on 9 March 2027 [[ev_a1]].\n\n* The pilot takes place at the Plovdiv depot [[ev_a1]].\n* It runs for six weeks [[ev_a1]].";
    expect(parseAnswer(text)).toEqual([
      { kind: "p", text: "The Orion field pilot starts on 9 March 2027 [[ev_a1]]." },
      { kind: "ul", items: [{ text: "The pilot takes place at the Plovdiv depot [[ev_a1]].", depth: 0 }, { text: "It runs for six weeks [[ev_a1]].", depth: 0 }] },
    ]);
    const out = render(text);
    expect(out.filter(([t]) => t === "li").map(([, s]) => s).join("")).toContain("The pilot takes place at the Plovdiv depot");
    expect(out.map(([, s]) => s).join("")).not.toMatch(/^\* |\n\* /);
    expect(out.map(([, s]) => s)).toContain("[cite:ev_a1]");
  });

  it("handles numbered lists, nesting, headings, bold, italics and code", () => {
    expect(parseAnswer("## Risks\n1. Wi-Fi\n2. Scanners\n   - six missing")).toEqual([
      { kind: "h", text: "Risks" },
      { kind: "ol", items: [{ text: "Wi-Fi", depth: 0 }, { text: "Scanners", depth: 0 }] },
      { kind: "ul", items: [{ text: "six missing", depth: 1 }] },
    ]);
    const out = render("Status is **Done**, *not* `pending`.");
    expect(out).toEqual(expect.arrayContaining([["strong", "Done"], ["em", "not"], ["code", "pending"]]));
  });

  it("never turns answer text into markup", () => {
    const out = render('<img src=x onerror="alert(1)"> **<script>alert(1)</script>** [link](javascript:alert(1))');
    const tags = new Set(out.map(([t]) => t));
    expect([...tags].every((t) => ["p", "strong", "text"].includes(t))).toBe(true);
    expect(out.map(([, s]) => s).join("")).toContain("<script>alert(1)</script>");
  });
});
