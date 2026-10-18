# ADR 0004 — ModelGateway and bounded agent runtime

Status: accepted (Phase 1) · Date: 2026-10-18

## Decision

- `ModelGateway` is provider-neutral (`generate`, normalized error kinds:
  timeout, cancelled, unavailable, rejected, invalid_config).
- Implementations:
  - `OpenAICompatibleGateway` (AI SDK `generateText` + `@ai-sdk/openai-compatible`).
    One configurable endpoint for vLLM/Ollama/llama.cpp or an approved hosted
    endpoint. The endpoint origin must be in `MODEL_APPROVED_ENDPOINTS`; in
    `MODEL_MODE=local` it must also be a loopback/private/single-label host.
    Checked at config load **and** in the constructor, before any request.
  - `FakeModelGateway`: deterministic, extractive, no network. Default for dev,
    tests and the offline demo; always labelled "fake" in the UI and API.
- `AgentRuntime` (Phase 1 scope): one knowledge search per run (no
  model-driven tool calling yet), score threshold, per-run budgets (tool calls,
  evidence, input chars, output tokens/chars, wall-clock via AbortSignal).
  Evidence goes into delimited blocks with tag-injection neutralized; platform
  rules are appended to the agent's instructions.
- Grounding: the model must cite `[[evidenceId]]`. Unknown IDs are stripped.
  An answer with no valid citation, or containing `INSUFFICIENT_EVIDENCE`,
  becomes an honest insufficient-evidence response. No model call is made when
  no authorized evidence passes the threshold.
- `AgentDefinition` is zod-validated and deep-frozen; capabilities are an enum
  (`knowledge.search` only), so a definition or model cannot grant new ones.

## Not yet

Streaming responses, model-driven tool calls, token accounting against quotas,
hybrid-mode content classification before external calls, egress tests at the
network layer. Answer quality with a real model is **unmeasured**.
