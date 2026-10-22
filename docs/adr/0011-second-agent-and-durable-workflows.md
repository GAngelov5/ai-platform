# ADR 0011 — Second agent and durable scheduled workflows

Status: accepted (Stage 3c) · Date: 2026-10-22 · Builds on ADR 0004, 0007 and 0008

## Questions

1. Can a second agent be added **without platform code**, proving the
   foundation is reusable?
2. How does a scheduled workflow survive restarts and duplicate deliveries,
   while every write it wants still goes through one approval?

## Decision 1 — The Meeting Preparation Assistant is a definition

`agents/meeting-prep` contains three things:
- a `defineAgent` definition: instructions, capabilities, knowledge scopes and limits
- labeled eval cases
- a test

It is registered in one line in `apps/api/src/deps.ts`, and the workspace
lists it automatically.

| It needs | It reuses |
|---|---|
| The user's next meeting | `calendar.events.list` (new capability binding, see below) |
| Decisions and history | `knowledge.search` → `PolicyEnforcingKnowledgeService` |
| Live task status | `tracker.task.status` (atlas-team only; others never get the tool) |
| Budgets, citations, abstention, audit | `AgentRuntime` |

It has **no write capability**, so it cannot propose an action.

### Platform additions this needed, and why they are platform concerns

- **The trusted caller identity in live reads.** `ReadHandler` now receives
  `principal` from `TrustedContext`. A personal data source (calendar now,
  Microsoft Graph mail and calendar in Stage 2) reads **only the signed-in
  user's** data. The model chooses the time window, never the owner. This is
  the same contract as a delegated OAuth token, and Stage 2 needs it anyway.
- **A calendar capability binding** (`packages/connectors/src/calendar.ts`),
  connected to a synthetic calendar MCP server (`/calendar/mcp` in the
  synthetic service, with its own token and pinned tool). This is
  integration work, exactly what the Graph calendar adapter will replace.
- **The fake test model learned the meeting flow:** read the calendar, then
  search per agenda item. That is test-double code; no agent code depends on
  it.

## Decision 2 — Workflows: state in PostgreSQL, the queue only says "check now"

```text
BullMQ "workflow-tick" (every 60 s)        PostgreSQL
──────────────────────────────────         ─────────────────────────────────────────────
dispatchDue()  ── one transaction ──▶      workflows (owner, kind, config, interval, next_run_at)
                  SELECT … FOR UPDATE      workflow_runs  UNIQUE (workflow_id, scheduled_for)
                  SKIP LOCKED              action_proposals.dedupe_key  UNIQUE (customer, key)
execute(run)   ── conditional claim ──▶    pending → running (attempt+1, heartbeat) → succeeded|failed
```

- **Duplicate dispatch or redelivery** cannot create a second run, because
  there is one row per slot. Two workers executing the same run: exactly one
  claims it, the other is skipped.
- **Crash recovery:** a run left `running` past a stale heartbeat (10
  minutes) is taken over. Only the current attempt may record the result.
- **Writes are proposals only.** A workflow proposes through `ActionService`
  with a **dedupe key**. For the status check, the key is
  `wf:<workflow>:<task>:<status>:<updatedAt>`. A retried run, a taken-over
  run, or a later run seeing the same state returns the existing proposal.
  So each logical write gets exactly one approval.
- **Current permissions.** Each run loads the owner again and re-checks the
  kind's capabilities against the owner's *current* groups. Revoked access
  makes the run fail as `forbidden`, with no reads and no proposals. Creating
  a workflow needs the same capabilities.
- **No back-fill.** After downtime a workflow runs once, then continues on
  its interval, instead of replaying every missed slot.

### The first workflow kind: tracker status check

`tracker-status-check {project, watchStatuses = [Blocked, At risk]}`:
1. It lists the project's tasks live and compares them with the previous
   successful run's snapshot.
2. For each task that **newly** entered a watched status, it proposes one
   comment asking for an update.

New kinds are registered in `WorkflowKindRegistry`. A kind declares the
capabilities it uses, and can call nothing else.

### API and UI

- `GET/POST /api/workflows`, `GET /api/workflows/:id/runs`,
  `POST /api/workflows/:id/{pause,resume,run-now}`, and
  `GET /api/workflow-kinds`. Every route is owner-only, and mutations need
  CSRF.
- Inbox → **Scheduled checks**: create a check, see its last run, run it now,
  pause it. Its proposals appear with the other approvals.
- Worker: the `workflow-tick` job, and a one-shot `workflows-tick` command.

## Evidence

- `packages/workflows/test/workflows.test.ts` (PGlite, real tracker MCP
  server, real ActionService), 9 tests:
  - creation permissions; first run; change detection
  - duplicate dispatch; concurrent claims; crash takeover without a
    duplicate proposal
  - revoked access; approval executes once; no back-fill; pause and run-now
- `agents/meeting-prep/test/evals.test.ts`: 3 labeled users through the real
  runtime and the real MCP connector to the synthetic calendar and tracker.
  It also checks that the calendar owner cannot be chosen by the question.
- `apps/api/test/api.test.ts`: both agents listed; workflow CSRF, ownership,
  validation, the run and its proposal, pause and run-now over HTTP.
- `scripts/stage3c-live-check.mjs` against the running stack (2026-10-22):
  the workflow and permission checks passed (14/14). The real-model
  briefings (`WITH_MODEL=1`, `qwen3:4b` on CPU) failed:
  - The routing was correct (calendar first, then tracker).
  - Alice's run reached the 10-minute limit before any document search.
  - Bob's answer had no valid citations, so it abstained.
  - Briefings need a faster or larger model (ROADMAP: model decision).

## Open questions

- **Workflow notifications.** Proposals now appear in the Inbox; email or
  Teams notifications wait for Stage 2.
- **Retry policy.** A failed run is terminal for its slot, and the next slot
  runs normally. Should transient connector errors be retried inside the
  slot?
- **More kinds:** a weekly digest, or a meeting briefing the evening before,
  delivered as a draft.
