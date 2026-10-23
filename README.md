# On-prem AI agent platform — Phase 1 (synthetic milestone)

A TypeScript platform that answers questions from **authorized** company
knowledge with verifiable citations. One isolated instance per customer.
This repository covers **Phase 1 plus the smallest synthetic knowledge-answering
slice** of the handoff. Every identity, document and answer here is synthetic.

> **Status:** synthetic demo only. No real company data and no external writes.
> Not security-certified. Knowledge backends: **LightRAG v1.5.7, verified live
> in local Docker/Colima** (partitioned by access, ADR 0006). RAGFlow v0.27.2 is
> implemented but only mock-tested (x86-only, ≥ 16 GB).

## What works

**Stage 1 integrations (ADR 0007/0008):**
- **Context router:** the agent routes each question to indexed documents
  (`knowledge.search`) and/or live tools (an allowlisted **MCP** tracker).
  The per-run allowlist is agent ∩ registered capabilities ∩ user's groups ∩
  connector health. Answers cite document evidence (`ev_`) and live reads
  (`lv_`, with read time), and state conflicts between dated documents and live state.
- **MCP:** official SDK client. Servers are allowlisted and tool definitions
  pinned by hash; responses are size-bounded; each server gets its own
  audience-bound token. A synthetic tracker MCP server runs in Compose.
- **Approvals:** write requests become proposals and never execute directly.
  The approval card shows the full operation; approving sends the exact
  payload hash. The worker executes through the outbox exactly once,
  re-authorizing first. A lost response becomes `unknown` and is reconciled.
- **Streaming:** run progress (tools used) streams over SSE, with cancellation.
- **Real local model** through Ollama (`qwen3:4b`). No egress: the API sits only on internal networks.

**Knowledge (Phase 1–2):**

- Dev sign-in as one of three synthetic principals (`alice`, `bob`, `carol`).
- Project Assistant answers "Why was Project Atlas delayed?" with only the
  fixture-supported blockers. Each citation resolves to a protected document view.
- Unsupported questions get an explicit insufficient-evidence response, with no model call.
- The denied principal (`bob`) sees no Atlas text, title or citation, and gets
  `404` on the documents. A forbidden memo (with a canary string) never reaches
  `alice`, the model prompt, the API response or the logs.
- Permission changes and tombstones apply at once, including to stored
  conversations (answers are withheld) and to citation links.

## Layout

```text
apps/web                 Next.js 16 chat UI (dashboard, chat, citations, document view)
apps/api                 NestJS 12 API (auth guard → TrustedContext, knowledge, conversations)
apps/worker              CLI: migrate | seed | lightrag-sync | ragflow-ingest | healthcheck | start (BullMQ)
packages/contracts       zod runtime schemas shared by API/web/agents
packages/database        Drizzle schema, migrations (drizzle/), repositories, PGlite test DB
packages/security        TrustedContext, access policy, config validation, egress guard, redaction
packages/knowledge       KnowledgeService (policy-enforcing), fixture, LightRAG v1.5.7 and RAGFlow v0.27.2 adapters
packages/ai              ModelGateway (OpenAI-compatible via AI SDK, deterministic fake), AgentRuntime
packages/agents          AgentDefinition + CapabilityRegistry (versioned capabilities, policy)
packages/connectors      Connector registry, MCP client (pinning, bounds), Atlas tracker capability bindings
packages/actions         ActionService: proposals, approvals, outbox execution, reconciliation
packages/ui              SourceCitation (document/live), ApprovalCard, RunStatus, AgentCard
services/mcp-atlas-tracker  Synthetic MCP server (live task state, idempotent comments)
agents/knowledge-assistant Core agent (documents only, always licensed) + evals
agents/project-assistant Add-on agent definition + labeled eval questions
agents/meeting-prep      Add-on agent: meeting briefings (definition + evals)
infra/compose            Compose base, dev overlay, Caddy, LightRAG + Ollama overlay, RAGFlow overlay
infra/docker/Dockerfile  Multi-target image build (api, worker, web)
fixtures/                Synthetic identities and Project Atlas documents
docs/adr                 Architecture decisions (0001–0009)
docs/ROADMAP.md          What's done, what's next, decisions waiting for you
scripts/smoke.mjs        End-to-end demonstration check over HTTP
scripts/lightrag-live-check.mjs  Live ACL-change / tombstone / deletion check against real LightRAG
scripts/integration-live-check.mjs  Live router + MCP + approval + egress check (real local model)
```

## Prerequisites

- Node.js 24 LTS, Corepack (`corepack enable`), which provides pnpm 12.9.1 from `packageManager`.
- Docker with Compose v2 (`docker compose` or `docker-compose`).
  About 2 GB RAM is enough for the platform. Build images one at a time on small VMs.

## Quick start A — full stack with Docker Compose (TLS)

```bash
export POSTGRES_PASSWORD=platform_dev          # dev only; production rejects it
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml build
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up -d
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml --profile seed run --rm seed
SMOKE_BASE_URL=https://localhost:8443 SMOKE_INSECURE_TLS=1 pnpm smoke
```

Open <https://localhost:8443>. The certificate comes from Caddy's internal
development CA, so your browser will warn about it. `SMOKE_INSECURE_TLS=1`
disables TLS verification for the smoke script only. Never use it against a
real deployment.

## Quick start C — real RAG backend: LightRAG + Ollama in Docker/Colima

Everything runs locally: three LightRAG partitions (one per access set), plus
Ollama serving `nomic-embed-text` and `qwen2.5:3b`. Give the Docker VM about
6 vCPU / 10 GiB, for example with `colima start --cpu 6 --memory 10`. The
first `up` downloads about 2.3 GB of models through the one-shot `ollama-pull`
job. That job is the only container in the overlay with internet access.

```bash
export POSTGRES_PASSWORD=platform_dev LIGHTRAG_API_KEY=dev-lightrag-key-0123456789
C="docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f infra/compose/lightrag/compose.lightrag.yaml"
$C build
$C up -d
$C --profile seed run --rm seed
$C --profile lightrag-sync run --rm lightrag-sync      # indexes fixtures (~2-3 min on CPU)
SMOKE_BASE_URL=https://localhost:8443 SMOKE_INSECURE_TLS=1 pnpm smoke
SMOKE_INSECURE_TLS=1 node scripts/lightrag-live-check.mjs   # permission change + deletion gate (~5-10 min)
```

Re-run `lightrag-sync` after changing fixtures, ACLs or tombstones. Access
checks apply immediately. The sync only makes the physical index catch up,
and it confirms each deletion. How the partitions work and why is in
[ADR 0006](docs/adr/0006-lightrag-partitioned-backend.md).

## Sources and ingestion (ADR 0009)

Indexed content comes from **sources**. Each source is a thin, system-specific
`SourceAdapter` (list changes, fetch content, native permissions) feeding one
generic pipeline. The pipeline handles parsing, permission mapping,
quarantine, the platform content store, deletion and the RAG sync.

- **Built in:**
  - `fixture`: the synthetic Atlas documents.
  - `folder`: a file share, where `.acl.json` files are inherited down folders.
    See `fixtures/sources/team-share`.
- **Configure** with `KNOWLEDGE_SOURCES` (JSON, see `.env.example`). Native
  groups map to platform groups through `aclMap`. Unmapped groups are dropped,
  and a document left with no platform group is unsearchable.
- **Run once:** `node dist/main.js ingest [sourceId] [--sync]` in the worker
  (locally: `pnpm --filter @platform/worker cli ingest`).
- **Scheduled:** the worker ingests every `INGEST_INTERVAL_MINUTES` (default
  15). If anything changed, it then syncs LightRAG.
- **Inspect:** each source's last run report is in `source_sync_state`, and
  failed items with their reason are in `source_quarantine`.
- **New systems** (SharePoint, Jira, SMB) add only an adapter plus its
  permission mapping. See ADR 0009 for the planned adapters.
- **Formats:** Markdown, text, HTML, PDF (`unpdf`) and DOCX (`mammoth`).
  PDF and DOCX are parsed in a worker thread with memory and time limits.
  Scans without a text layer are quarantined as `needs_ocr` (ADR 0010).

## Retrieval evaluation (ADR 0010)

A synthetic corpus of 110 files and 34 labeled questions measures a
knowledge backend against the pilot gates: recall, abstention, leaks and
version handling.

```bash
node scripts/generate-eval-corpus.mjs        # deterministic; already committed
# Local API with the lexical backend:
KNOWLEDGE_INCLUDE_EVAL_CORPUS=true pnpm --filter @platform/worker cli ingest eval-corpus
EVAL_BASE_URL=http://localhost:4000 EVAL_LABEL=lexical node scripts/eval-retrieval.mjs
# LightRAG: stack compose.lightrag-eval.yaml on every command, run lightrag-sync, then
EVAL_BASE_URL=https://localhost:8443 SMOKE_INSECURE_TLS=1 EVAL_LABEL=lightrag node scripts/eval-retrieval.mjs
```

Reports are written to `docs/eval/`. Use
`EVAL_QUESTIONS=fixtures/eval/questions-hard.json` for the hard set
(paraphrases, multi-document questions, near-misses).

**Evidence score:** `EVIDENCE_SCORING=lexical` (default, query-term overlap)
or `semantic`. Semantic scoring uses embedding similarity from local Ollama
(`EMBEDDING_BASE_URL`, `nomic-embed-text`) and is calibrated with
`scripts/calibrate-semantic.mjs` (ADR 0010, Decision 4).

## Quick start D — integrations: real local model, MCP and approvals

This builds on Quick start C (same Ollama and LightRAG) and adds the MCP
tracker and the real model. It needs the same 6 vCPU / 10 GiB VM. The first
run pulls `qwen3:4b` (about 2.5 GB).

```bash
export POSTGRES_PASSWORD=platform_dev LIGHTRAG_API_KEY=dev-lightrag-key-0123456789 MCP_TOKEN_ATLAS_TRACKER=dev-tracker-token-0123456789abcd MCP_TOKEN_CALENDAR=dev-calendar-token-0123456789abcd
C="docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f infra/compose/lightrag/compose.lightrag.yaml -f infra/compose/integrations/compose.integrations.yaml"
$C build && $C up -d
$C --profile seed run --rm seed && $C --profile lightrag-sync run --rm lightrag-sync
SMOKE_INSECURE_TLS=1 node scripts/integration-live-check.mjs     # ~15 min on CPU (4 real-model answers)
```

In the UI (https://localhost:8443) as **Alice**, try:
- "What is the current status of the Atlas customer data migration task, and why was it delayed originally?"
  The answer cites both live and document sources.
- `Add a comment to ATLAS-180 saying "Readiness review moved to 3 November"`
  An approval card appears. Approve it, and the card shows the receipt.

As **Bob**, the tracker tools are never offered.

On CPU, `qwen3:4b` takes about 2–6 minutes per answer (measured: 127–343 s). For interactive speed, use a
GPU host, or Ollama natively on the Mac (Metal) as an approved local endpoint
(ADR 0007).

## Bulgarian (ADR 0013)

- Bulgarian documents and questions work end to end: Cyrillic-aware search
  with a light Bulgarian stemmer, and answers in the question's language.
- The UI has an **EN | БГ** switch in the header.
- For production Bulgarian content, use a multilingual embedding model
  (e.g. `bge-m3`) and evaluate the chat model in Bulgarian first.

## Licence and the core assistant (ADR 0014)

- A signed licence file (`LICENCE_FILE`) lists the add-on agents and workflow
  kinds. It is verified offline with Ed25519; production refuses the
  development key.
- The **Knowledge Assistant** (documents only) is core and always available.
  Add-ons keep working for 14 days after expiry, then stop.
- Development licences are in `fixtures/licence/`. Vendor tool:
  `node scripts/licence.mjs keygen | sign`.

## Second agent and scheduled checks (ADR 0011)

- **Meeting Preparation Assistant:** choose it in the workspace and ask
  "Prepare me for my next meeting." It reads *your* calendar (synthetic
  calendar MCP at `/calendar/mcp`), the documents you may read, and live
  tracker status. It cannot propose writes.
- **Scheduled checks:** Inbox → Scheduled checks. A tracker status check runs
  in the worker with your current access. When a task becomes blocked or at
  risk, it proposes one comment for your approval.
- Live check: `SMOKE_INSECURE_TLS=1 WITH_MODEL=1 node scripts/stage3c-live-check.mjs`.
- Manual test steps for every stage: [docs/MANUAL-TESTING.md](docs/MANUAL-TESTING.md).

## Quick start B — local dev servers (hot reload)

```bash
pnpm install
cp .env.example .env
export POSTGRES_PASSWORD=platform_dev
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up -d postgres valkey
pnpm db:migrate && pnpm db:seed
pnpm dev                                      # API :4000, web :3000 (proxies /api)
SMOKE_BASE_URL=http://localhost:3000 pnpm smoke
```

## Checks

```bash
pnpm typecheck     # tsc (TypeScript 7) across all packages
pnpm test          # Vitest: unit, policy, runtime, labeled evals, HTTP tests on PGlite
pnpm build         # all packages + Next.js production build
pnpm smoke         # the milestone demonstration over HTTP (needs a running stack)
```

What the tests do and do not prove:

| Suite | Uses | Proves |
|---|---|---|
| `packages/security` | pure functions | production config rejection, ACL fail-closed rules, endpoint allowlist |
| `packages/knowledge` service tests | fixture adapter, in-memory catalog | prefilter, defense-in-depth drop, scope, document/evidence protection, revocation |
| `packages/knowledge` **ragflow.mock** | **stubbed fetch** | request shaping, fail-closed when unscoped, error normalization. **Not** a real RAGFlow test |
| `packages/knowledge` **lightrag.mock** | **in-memory fake LightRAG API** | partition routing, stale-placement skip, verbatim-chunk mapping, sync insert/move/delete logic |
| `scripts/lightrag-live-check.mjs` | **real LightRAG + Ollama containers** | ACL change before/after sync, tombstone hidden immediately and then physically deleted (confirmed), restore |
| `packages/connectors` mcp | **real MCP server in-process (HTTP)** | pinning, unpinned tools, size bound, bad token, idempotency, lost response → `ambiguous_outcome` |
| `packages/actions` | real MCP server + PGlite | forged, modified, expired and wrong-user approvals; revoked privilege; concurrent claims; duplicate delivery; reconciliation |
| `packages/ai` runtime | fake tool-calling model | allowlist by group and health, argument validation, budget, write→proposal, live citations, injection neutralization |
| `scripts/integration-live-check.mjs` | **real model + LightRAG + MCP tracker** | routing, live and document citations, approval executes once, policy, injection, no egress |
| `packages/ai` | fake model, stub knowledge | citation validation, abstention, limits, capability immutability, injection neutralization |
| `agents/project-assistant` evals | fixture adapter + **fake model** | grounding plumbing on 4 labeled cases. **Not** real model quality |
| `apps/api` | real NestJS + real migrations on PGlite | forged identity, CSRF, ownership, citation access, revocation, audit content |
| `scripts/smoke.mjs` | running stack | the full first-milestone demonstration |

## Configuration

All settings are environment variables, validated at startup by
`packages/security/src/config.ts`. See [.env.example](.env.example).

- `APP_ENV=production` refuses to start with: dev auth, `AUTH_MODE != oidc`,
  missing OIDC settings, `COOKIE_SECURE=false`, a non-https origin, a
  development DB password, the fixture knowledge provider, or the fake model.
- `AUTH_MODE=oidc` is validated but **not implemented**. The API exits with
  code 78 until Phase 7.
- Models: `MODEL_PROVIDER=openai-compatible` needs `MODEL_BASE_URL` whose
  origin is listed in `MODEL_APPROVED_ENDPOINTS`. `MODEL_MODE=local` also
  requires a local or private host. Example with a local Ollama:
  `MODEL_BASE_URL=http://localhost:11434/v1 MODEL_NAME=llama3.1:8b MODEL_APPROVED_ENDPOINTS=http://localhost:11434`.
  The real-model path compiles and enforces its endpoint policy, but it was
  **not exercised** in this milestone.
- Integrations: `MCP_SERVERS` is a JSON allowlist with pinned tool hashes.
  Each server's token comes from its own secret, `MCP_TOKEN_<SERVER_ID>`.
  `ACTION_PROPOSAL_TTL_MINUTES` sets how long a proposal stays approvable
  (default 30). Review pins with the worker command `mcp-pins <url> <serverId>`.
- Branding: `BRAND_NAME`. Customer: `CUSTOMER_ID`, which must match
  `fixtures/identities.json` for seeding.

## Real RAGFlow verification (not done here)

LightRAG is the backend verified live (above). RAGFlow stays an alternative adapter.

The adapter targets **RAGFlow v0.27.2**. Its endpoints were taken from that
tag's `docs/references/http_api_reference.md`. It has only been tested against
mocked HTTP.

**Blocker in the milestone environment:** the Docker VM has 2 vCPU / 2 GiB RAM.
The upstream RAGFlow stack (RAGFlow server, Elasticsearch, MySQL, MinIO,
Redis) needs at least 4 CPU / 16 GB RAM / 50 GB disk and `vm.max_map_count >= 262144`.

To run the remaining check on a suitable host, follow
[infra/compose/ragflow/README.md](infra/compose/ragflow/README.md):
fetch the pinned upstream stack, create a dataset and API key, start the
platform with the RAGFlow overlay, run `ragflow-ingest`, then run `pnpm smoke`.
Also record retrieval results for the labeled questions, revocation after
indexing, and resource usage (ADR 0003).

## Security notes

- Identity comes only from the server-side session. Client headers and body
  fields are never trusted. Request schemas are strict.
- Source permissions are enforced before retrieval, and again on every result,
  document view, citation and stored answer.
- Logs are structured JSON with redaction. Audit rows record metadata only,
  never message bodies, queries or excerpts.
- Databases and the queue sit on an internal network with no egress. Only the
  TLS proxy is published, on localhost by default.

## Not done / next gate

Not implemented yet: OIDC, Microsoft Graph (Stage 2), the admin console, OCR,
Playwright tests, backups and restore drills. Those are later stages; see
[docs/ROADMAP.md](docs/ROADMAP.md).
**Gate status:** source permission changes and deletion handling are proven
against the real, pinned **LightRAG** backend on synthetic data (ADR 0006).
The selection evaluation (ADR 0010, `docs/eval/`) runs over 110 synthetic
documents. Still open: citation support and model-level abstention, which
need real model answers, and whether one partition per access set scales to
the real ACL model.
