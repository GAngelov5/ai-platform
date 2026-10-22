import { defineAgent } from "@platform/agents";

/**
 * Second agent (Stage 3c). Only a definition: it reuses the platform's
 * knowledge search, the calendar and tracker capabilities, the router and its
 * limits. It has no write capability, so it can never propose an action.
 */
export const meetingPrep = defineAgent({
  id: "meeting-prep",
  version: "0.1.0",
  name: "Meeting Preparation Assistant",
  description: "Prepares a short briefing for your next meeting from your calendar, authorized documents and the live tracker.",
  instructions: `You are the Meeting Preparation Assistant for this company.
First find the user's next meeting (or the one they name) in their calendar.
Then, for each agenda item, look up relevant decisions, history and figures in the documents, and current task status in the tracker when a task key is mentioned.
Answer as a briefing: the meeting (title, time, attendees), then one bullet per agenda item with the key facts, then open questions or risks to raise.
Only state what the calendar, documents or tracker say. If nothing relevant is found for an agenda item, say so.`,
  capabilities: ["calendar.events.list", "knowledge.search", "tracker.task.status"],
  knowledgeScopes: { sourceIds: ["atlas-project-docs", "company-handbook", "team-share"] },
  outputSchema: "cited-answer@1",
  limits: {
    maxToolCalls: 6,
    maxEvidence: 6,
    minEvidenceScore: 0.6,
    maxInputChars: 2000,
    maxOutputTokens: 4096,
    maxOutputChars: 5000,
    maxDurationMs: 600_000,
  },
});
