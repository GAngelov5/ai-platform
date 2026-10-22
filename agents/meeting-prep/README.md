# Meeting Preparation Assistant

The second agent (Stage 3c, ADR 0011). It proves the platform is reusable: the
package holds only a **definition** (`src/index.ts`), **labeled eval cases**
(`evals/questions.json`) and a test. Everything else comes from the platform:

| Needs | Comes from |
|---|---|
| The user's next meeting | `calendar.events.list` capability (calendar MCP server; the owner is always the signed-in user) |
| Decisions, history, figures | `knowledge.search` through the policy-enforcing `KnowledgeService` |
| Current task status | `tracker.task.status` (only for members of `atlas-team`; others never see the tool) |
| Limits, citations, abstention, audit | `AgentRuntime` |

It has no write capability, so it can never propose an action.

Registered in `apps/api/src/deps.ts`; the workspace lists it automatically.
