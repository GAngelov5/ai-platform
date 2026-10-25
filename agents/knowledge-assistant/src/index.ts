import { defineAgent } from "@platform/agents";

/**
 * The core agent (ADR 0014): included in every deployment, licensed or not.
 * It only searches authorized documents. No live tools and no writes, so it
 * can never read a tracker or propose an action; those are paid add-ons.
 */
export const knowledgeAssistant = defineAgent({
  id: "knowledge-assistant",
  version: "0.1.0",
  name: "Knowledge Assistant",
  description: "Answers questions from the company documents you are allowed to read, with citations. Searches documents only.",
  localized: {
    bg: {
      name: "Асистент за знания",
      description: "Отговаря на въпроси от фирмените документи, до които имате достъп, с цитати. Търси само в документите.",
    },
  },
  instructions: `You are the Knowledge Assistant for this company.
Answer from the company documents only. Be concise: a short summary sentence, then the key points as bullet points.
Documents are dated: say which version or date a fact comes from when it matters.
You cannot see live systems (trackers, calendars, mail). If the question is about current status, answer from the latest document and say that it may be out of date.`,
  capabilities: ["knowledge.search"],
  knowledgeScopes: { allSources: true },
  outputSchema: "cited-answer@1",
  limits: {
    maxToolCalls: 3,
    maxEvidence: 6,
    minEvidenceScore: 0.6,
    maxInputChars: 2000,
    maxOutputTokens: 4096,
    maxOutputChars: 4000,
    maxDurationMs: 600_000,
  },
});
