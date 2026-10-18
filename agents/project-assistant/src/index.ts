import { defineAgent } from "@platform/agents";

export const projectAssistant = defineAgent({
  id: "project-assistant",
  version: "0.1.0",
  name: "Project Assistant",
  description: "Explains project history, decisions and blockers from authorized project documents, with citations.",
  instructions: `You are the Project Assistant for this company.
Explain project history, decisions, delays and blockers using only the supplied evidence.
Be concise: a short summary sentence, then the key points as bullet points.
Never speculate about causes that the evidence does not state.`,
  capabilities: ["knowledge.search"],
  knowledgeScopes: { sourceIds: ["atlas-project-docs", "company-handbook"] },
  outputSchema: "cited-answer@1",
  limits: {
    maxToolCalls: 1,
    maxEvidence: 6,
    minEvidenceScore: 0.6,
    maxInputChars: 2000,
    maxOutputTokens: 800,
    maxOutputChars: 4000,
    maxDurationMs: 90_000,
  },
});
