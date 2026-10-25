import { detectLanguage, splitSentences, terms } from "@platform/knowledge";
import type { GenerateRequest, GenerateResult, ModelGateway, ModelTool } from "./gateway.js";

export const INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE";

interface DocResult { evidence?: { id: string; title: string; text: string }[] }
interface LiveResult { readAt?: string; results?: { id: string; resourceId: string; title: string; data: Record<string, unknown> }[] }
interface ProposalResult { proposalId?: string; operation?: string; state?: string }

const LIVE_INTENT = /\b(current|currently|now|today|latest|live|status|right now)\b/i;
const COMMENT_INTENT = /\b(add|post|leave|write)\b[^.?!]*\bcomment\b/i;
const MEETING_INTENT = /\b(meeting|meetings|prepare|prep|briefing)\b/i;

/**
 * Deterministic stand-in for a tool-calling model. It never calls the network.
 * It follows a fixed, inspectable policy so the router, guards and citation
 * logic can be tested end to end:
 *   0. for meeting questions: read the calendar; the next meeting's title and
 *      agenda become the search query
 *   1. knowledge search with the question (if offered)
 *   2. for "current/status" questions: list tasks, pick the best match, read its status
 *   3. for explicit "add a comment" requests: propose the comment (never executes)
 * The answer is extractive and cites only ids returned by tools.
 */
export class FakeModelGateway implements ModelGateway {
  readonly descriptor = { provider: "fake", name: "deterministic-tool-router-v2" };
  readonly calls: GenerateRequest[] = [];
  /** Tool names in the order the fake invoked them (for tests). */
  readonly toolLog: string[] = [];

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    this.toolLog.length = 0;
    if (req.signal?.aborted) throw req.signal.reason;
    const question = req.messages.at(-1)?.content ?? "";
    const tools = new Map((req.tools ?? []).map((t) => [t.name, t]));
    const call = async (name: string, input: unknown) => {
      const t = tools.get(name) as ModelTool | undefined;
      if (!t) return undefined;
      this.toolLog.push(name);
      return t.execute(input, { signal: req.signal });
    };

    let meeting: NonNullable<LiveResult["results"]>[number] | undefined;
    if (MEETING_INTENT.test(question) && tools.has("calendar_events_list")) {
      meeting = ((await call("calendar_events_list", { days: 7 })) as LiveResult | undefined)?.results?.[0];
    }
    const topic = meeting ? `${String(meeting.data.title ?? "")} ${String(meeting.data.agenda ?? "")}` : question;
    // A meeting is researched one agenda item at a time (as a real model would), within the tool budget.
    const queries = meeting
      ? String(meeting.data.agenda ?? "")
          .split(/\s*\d+\.\s+|[.:;,]\s+|\s+and\s+/)
          .map((i) => i.trim())
          .filter((i) => i.length > 3)
          .slice(0, 4)
          .map((i) => `${String(meeting!.data.title ?? "").split(" ")[0]} ${i}`)
      : [question];
    const docs: DocResult = { evidence: [] };
    for (const query of queries.length ? queries : [topic]) {
      const r = ((await call("knowledge_search", { query: query.slice(0, 500) })) ?? {}) as DocResult;
      docs.evidence!.push(...(r.evidence ?? []));
    }
    let live: LiveResult | undefined;
    let proposal: ProposalResult | undefined;
    const wantsLive = LIVE_INTENT.test(question) || COMMENT_INTENT.test(question);
    let taskKey = /\b([A-Z]+-\d+)\b/.exec(question)?.[1];
    if (wantsLive && tools.has("tracker_tasks_list")) {
      const list = (await call("tracker_tasks_list", { project: "ATLAS" })) as LiveResult | undefined;
      if (!taskKey && list?.results?.length) {
        const q = new Set(terms(question));
        const best = [...list.results].sort((a, b) => overlap(q, b.title) - overlap(q, a.title))[0];
        if (best && overlap(q, best.title) > 0) taskKey = best.resourceId;
      }
      if (taskKey) live = (await call("tracker_task_status", { taskKey })) as LiveResult | undefined;
    }
    if (COMMENT_INTENT.test(question) && taskKey) {
      const text = /["“']([^"”']{3,500})["”']/.exec(question)?.[1] ?? /\bsaying\s+(.{3,500})$/i.exec(question)?.[1];
      if (text) proposal = (await call("tracker_task_comment", { taskKey, text: text.trim() })) as ProposalResult | undefined;
    }

    const lines: string[] = [];
    if (meeting) {
      const d = meeting.data as { title?: string; start?: string; attendees?: string[] };
      lines.push(`- Next meeting: ${d.title} at ${d.start}, with ${(d.attendees ?? []).join(", ")} [[${meeting.id}]]`);
    }
    const q = [...new Set(terms(meeting ? topic : question))];
    // A meeting's evidence was already retrieved per agenda item: one shared topic term makes a sentence relevant.
    const needed = meeting ? 1 : Math.max(2, Math.ceil(q.length * 0.6));
    // Candidate sentences: those sharing enough question words (after a light English stem).
    const qs = [...new Set(q.map(stem))];
    const seen = new Set<string>();
    const picked: { s: string; id: string; words: Set<string>; order: number }[] = [];
    for (const e of docs.evidence ?? []) {
      // A sentence also "says" its page title and section heading ("Risk 1: weak Wi-Fi" under "Risks" of "Project Orion").
      const titleTerms = terms(e.title);
      let headingTerms: string[] = [];
      for (const raw of splitSentences(e.text)) {
        if (/^#{1,6}\s/.test(raw.trim())) headingTerms = terms(raw);
        const s = readableSentence(raw);
        if (!s || seen.has(s)) continue;
        const words = new Set([...terms(s), ...headingTerms, ...titleTerms].map(stem));
        if (qs.filter((t) => words.has(t)).length >= Math.min(needed, qs.length)) {
          seen.add(s);
          picked.push({ s, id: e.id, words, order: picked.length });
        }
      }
    }
    // Rank by the rarer question words a sentence contains (a word in every candidate, like the project
    // name, says little); keep those close to the best, best first, at most six bullets in total.
    const df = (t: string) => picked.filter((p) => p.words.has(t)).length;
    const weight = new Map(qs.map((t) => [t, Math.log(1 + picked.length / Math.max(1, df(t)))]));
    const score = (p: (typeof picked)[number]) => qs.reduce((n, t) => n + (p.words.has(t) ? weight.get(t)! : 0), 0);
    const ranked = picked.map((p) => ({ ...p, score: score(p) })).sort((a, b) => b.score - a.score || a.order - b.order);
    const best = ranked[0]?.score ?? 0;
    // A meeting briefing keeps every agenda match.
    const strong = meeting ? ranked : ranked.filter((p) => p.score >= best * 0.6);
    for (const p of strong.slice(0, 6 - lines.length)) lines.push(`- ${p.s} [[${p.id}]]`);
    const liveItem = live?.results?.[0];
    if (liveItem) {
      const d = liveItem.data as { status?: string; updatedAt?: string };
      lines.push(`- Current tracker status of ${liveItem.resourceId} (${liveItem.title}): ${d.status ?? "unknown"}, last updated ${d.updatedAt ?? "unknown"} [[${liveItem.id}]]`);
      if (lines.length > 1) lines.push("- Note: the documents are dated; the tracker value is the current live state as read now.");
    }
    if (proposal?.proposalId) {
      lines.push(`- I prepared a proposal: ${proposal.operation}. It has NOT been executed; approve or reject it in the approval card.`);
    }
    const intro = detectLanguage(question) === "bg" ? "Според цитираните източници:" : "Based on the cited sources:";
    const text = lines.length ? `${intro}\n${lines.join("\n")}` : INSUFFICIENT_EVIDENCE;
    return {
      text,
      finishReason: "stop",
      usage: { inputTokens: Math.ceil(JSON.stringify(req.messages).length / 4), outputTokens: Math.ceil(text.length / 4) },
      model: this.descriptor,
      steps: this.toolLog.length + 1,
    };
  }
}

/** Light English stem for matching only: "delayed", "delays" and "delay" compare equal. */
const stem = (w: string) => (/^[a-z]+$/.test(w) && w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, "") : w);

/**
 * A source line as a reader-facing sentence: Markdown list, checkbox, quote and
 * table markers removed. Headings, table rules and bare labels carry no facts
 * on their own, so they are skipped (undefined).
 */
export function readableSentence(line: string): string | undefined {
  const t = line.trim();
  if (!t || /^#{1,6}\s/.test(t) || /^\|?[\s:|-]+\|?$/.test(t) || /^```/.test(t)) return undefined;
  const s = t
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^\|\s*|\s*\|$/g, "")
    .replace(/\s*\|\s*/g, " · ")
    .trim();
  // A short label ("Budget", "Risks:") is a heading in disguise.
  return s.split(/\s+/).length < 3 ? undefined : s;
}

function overlap(q: Set<string>, title: string): number {
  return terms(title).filter((t) => q.has(t)).length;
}
