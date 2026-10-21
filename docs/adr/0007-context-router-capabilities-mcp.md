# ADR 0007 — Context router, capability registry, connectors and MCP

Status: accepted (Stage 1) · Date: 2026-10-21

## Decision

**Capabilities are the only door to tools.** `CapabilityRegistry`
(`packages/agents`) holds versioned entries with:
- an id
- a zod input schema
- a `read` or `write` kind
- `requiredGroups`, a timeout and an optional connector

Each entry carries a read handler or a write binding. Agent definitions name
capability IDs; an unknown ID is simply not available (fail closed).

**Context router** (`AgentRuntime`, `packages/ai/src/runtime.ts`):
- **Per-run allowlist** = agent capabilities ∩ registered ∩ principal groups
  (loaded server-side) ∩ healthy connectors. The model sees only these tools.
- **The model chooses tools in a bounded loop.** AI SDK `generateText` with
  `stopWhen: stepCountIs(maxToolCalls + 1)`. Each tool goes through a platform
  guard that:
  - re-validates input with zod
  - enforces the tool-call budget and per-tool timeouts
  - records `tool_calls` (argument hash only)
  - converts results into run-scoped evidence:
    - `knowledge.search` → `ev_…` document evidence, through the
      policy-enforcing KnowledgeService (ADR 0003/0006)
    - live reads → `lv_…` evidence with `readAt` and the external resource ID,
      persisted in `live_evidence` and resolvable only by the same principal
    - writes → `ActionService.propose` only (ADR 0008). Nothing executes in the runtime.
- **Routing rules in the system prompt** (handoff §1): documents for dated
  history, live tools for current state; state conflicts with both dates;
  tool output is untrusted; call write tools only when the user asked.
- **Server-side guarantees that do not depend on model quality:**
  - citations are filtered to issued IDs
  - uncited answers become an honest insufficient-evidence response
  - tags inside tool data are neutralized, and size is bounded
  - reasoning traces (`<think>`) are stripped

**Connectors** (`packages/connectors`): a `Connector` interface and a
registry, with the handoff's error vocabulary: `denied`, `unavailable`,
`throttled`, `invalid_input`, `ambiguous_outcome`. A timeout on a write
becomes `ambiguous_outcome`, never a retry.

**MCP client** (`McpConnector`, official `@modelcontextprotocol/sdk` 1.32):
- An allowlist of servers in `MCP_SERVERS`, with private-network URLs only.
- **Tool definitions are pinned**: SHA-256 of the canonical
  `{name, description, inputSchema}`. A tool that is unpinned, changed or
  missing is disabled, and a mismatch is a security event.
- Responses are size-bounded.
- Credentials are an audience-bound bearer token per server
  (`MCP_TOKEN_<ID>`, a secret reference); user tokens are never passed through.
- Pin review: `node dist/main.js mcp-pins <url> <serverId>` in the worker.

**Test integration:** `services/mcp-atlas-tracker` is a synthetic MCP server
(Streamable HTTP, stateless) with:
- live task state that is newer than the May documents
- an idempotent `task_add_comment` and `task_find_comment` for reconciliation
- one planted prompt-injection string

It runs on an internal `tools` network.

**Streaming:** `POST /api/conversations/:id/messages/stream` sends
`run.started`, then `tool.started`/`tool.finished`, then `message` as SSE.
Closing the connection aborts the run. Citations are validated before the
final event, so answer tokens are not streamed.

## Model choice (measured on Colima, 6 vCPU, CPU-only)

| Model | Tool routing | Latency per routed question |
|---|---|---|
| `qwen2.5:3b` | calls tools, but wrong arguments and no citations | ~30 s |
| `qwen3:4b` | correct: list → status with the right key, plus documents, and cites both | ~3–4 min (thinking cannot be fully disabled through the OpenAI-compatible endpoint) |
| `qwen2.5:7b` | not runnable: killed at the 5 GB Ollama limit | — |

Qwen3 spends output tokens on hidden reasoning, so the agent's
`maxOutputTokens` is 4096. With 800 it produced empty answers.

**Live run, 2026-10-21** (`scripts/integration-live-check.mjs`, `qwen3:4b`, CPU):

| Question | Latency |
|---|---|
| Routed status plus history question | 326 s |
| Comment proposal | 343 s |
| Live status with the injection probe | 127 s |

All behavioural checks passed: live and document citations, one proposal,
approval executes once, policy, injection and egress. The single failing check
in that run required `tracker.task.status` specifically. The model correctly
used `tracker.tasks.list`, which already carries live status, so the check was
relaxed to accept either live read.

The default is `qwen3:4b` (`PLATFORM_MODEL_NAME`), chosen for correctness. For
interactive speed, use a GPU host, or run Ollama natively with Metal on the
Mac and point `MODEL_BASE_URL` at it (an approved local endpoint). This is a
hardware and sizing decision for the pilot.

## Consequences

- New tools are added as capability bindings: platform code with schemas and
  policy. A new MCP server exposes nothing until bindings and pins exist.
- The MCP test server's pins live in the integrations overlay. Any change to
  its tool definitions disables those tools until the pins are re-reviewed.
