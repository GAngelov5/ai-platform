import { Fragment, type ReactNode } from "react";

/**
 * Answer text as formatted content: paragraphs, bullet and numbered lists,
 * headings, **bold**, *italics*, `code`, and [[ev_…]] citation markers.
 *
 * Deliberately small and safe: it builds React elements from text and never
 * injects HTML, so nothing a model (or a document it quotes) writes can add
 * markup, scripts or links to the page. Anything it doesn't recognise stays
 * plain text.
 */

export type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul" | "ol"; items: { text: string; depth: number }[] };

const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

/** Splits answer text into blocks. Pure, so it can be tested without a DOM. */
export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    const h = HEADING.exec(line.trim());
    if (b || n) {
      flush();
      const kind = b ? "ul" : "ol";
      const [, indent, body] = (b ?? n)!;
      const depth = Math.min(2, Math.floor(indent!.replace(/\t/g, "    ").length / 2));
      const last = blocks.at(-1);
      if (last && last.kind === kind) last.items.push({ text: body!, depth });
      else blocks.push({ kind, items: [{ text: body!, depth }] });
    } else if (h) {
      flush();
      blocks.push({ kind: "h", text: h[1]! });
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

const INLINE = /(\[\[(?:ev|lv)_[A-Za-z0-9_-]+\]\]|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;

function inline(text: string, cite: (id: string) => ReactNode, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (!part) return null;
    const id = /^\[\[((?:ev|lv)_[A-Za-z0-9_-]+)\]\]$/.exec(part)?.[1];
    if (id) return <Fragment key={k}>{cite(id)}</Fragment>;
    if (/^(\*\*|__).+\1$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (/^`.+`$/.test(part)) return <code key={k} className="rounded bg-panel px-1 font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    if (/^([*_]).+\1$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
    return <Fragment key={k}>{part}</Fragment>;
  });
}

export function AnswerMarkdown({ text, cite }: { text: string; cite: (evidenceId: string) => ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      {parseAnswer(text).map((b, i) => {
        if (b.kind === "h") return <p key={i} className="font-bold">{inline(b.text, cite, `h${i}`)}</p>;
        if (b.kind === "p") return <p key={i} className="whitespace-pre-line">{inline(b.text, cite, `p${i}`)}</p>;
        const List = b.kind === "ul" ? "ul" : "ol";
        return (
          <List key={i} className={`m-0 flex flex-col gap-1 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"}`}>
            {b.items.map((it, j) => (
              <li key={j} style={it.depth ? { marginLeft: `${it.depth * 1.1}rem` } : undefined}>
                {inline(it.text, cite, `l${i}-${j}`)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
