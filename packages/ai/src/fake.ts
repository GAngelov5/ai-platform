import { splitSentences, terms } from "@platform/knowledge";
import type { GenerateRequest, GenerateResult, ModelGateway } from "./gateway.js";

export const INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE";

/**
 * Deterministic, extractive stand-in for a language model. It reads the
 * evidence blocks the runtime placed in the prompt and returns sentences that
 * share most terms with the question, each followed by its [[evidenceId]].
 * It makes no network calls. Used for tests and the offline demo only; it is
 * labelled as "fake" everywhere it is surfaced.
 */
export class FakeModelGateway implements ModelGateway {
  readonly descriptor = { provider: "fake", name: "deterministic-extractive-v1" };
  readonly calls: GenerateRequest[] = [];

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    if (req.signal?.aborted) throw req.signal.reason;
    const prompt = req.messages.at(-1)?.content ?? "";
    const question = /<question>([\s\S]*?)<\/question>/.exec(prompt)?.[1] ?? "";
    const q = [...new Set(terms(question))];
    const needed = Math.max(2, Math.ceil(q.length * 0.6));
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const m of prompt.matchAll(/<evidence id="(ev_[A-Za-z0-9_-]+)"[^>]*>([\s\S]*?)<\/evidence>/g)) {
      const [, id, body] = m;
      for (const s of splitSentences(body!)) {
        const st = new Set(terms(s));
        const hits = q.filter((t) => st.has(t)).length;
        if (hits >= Math.min(needed, q.length) && !seen.has(s)) {
          seen.add(s);
          lines.push(`- ${s} [[${id}]]`);
        }
      }
      if (lines.length >= 6) break;
    }
    const text = lines.length ? `Based on the cited sources:\n${lines.slice(0, 6).join("\n")}` : INSUFFICIENT_EVIDENCE;
    return {
      text,
      finishReason: "stop",
      usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4) },
      model: this.descriptor,
    };
  }
}
