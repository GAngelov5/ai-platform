import { defineAgent } from "@platform/agents";

export const projectAssistant = defineAgent({
  id: "project-assistant",
  version: "0.3.0",
  name: "Project Assistant",
  description:
    "Explains project history, decisions and blockers from authorized documents, checks live task status, and prepares tracker comments for your approval.",
  localized: {
    bg: {
      name: "Проектен асистент",
      description:
        "Обяснява историята, решенията и блокерите на проектите от документите, до които имате достъп, проверява текущия статус на задачите и подготвя коментари в тракера за ваше одобрение.",
    },
  },
  instructions: `You are the Project Assistant for this company.
Explain project history, decisions, delays and blockers from the documents, and current task status from the live tracker.
Be concise: a short summary sentence, then the key points as bullet points.
Never speculate about causes that the evidence does not state.`,
  capabilities: ["knowledge.search", "tracker.tasks.list", "tracker.task.status", "tracker.task.comment"],
  knowledgeScopes: { sourceIds: ["atlas-project-docs", "company-handbook", "team-share"] },
  outputSchema: "cited-answer@1",
  limits: {
    maxToolCalls: 4,
    maxEvidence: 6,
    minEvidenceScore: 0.6,
    maxInputChars: 2000,
    // Reasoning models (e.g. qwen3) spend output tokens on hidden thinking before tool calls.
    maxOutputTokens: 4096,
    maxOutputChars: 4000,
    // Generous for CPU-only local models; enforced end to end via AbortSignal.
    maxDurationMs: 600_000,
  },
});
