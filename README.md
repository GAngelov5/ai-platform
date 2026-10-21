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
packages/agents          AgentDefinition schema + registry
packages/connectors      Phase 5 placeholder (types only, no connectors)
packages/actions         Phase 5 placeholder (types only, no actions)
packages/ui              SourceCitation, AgentCard
agents/project-assistant Agent definition + labeled eval questions
agents/meeting-prep      Phase 6 placeholder (README only)
infra/compose            Compose base, dev overlay, Caddy, LightRAG + Ollama overlay, RAGFlow overlay
infra/docker/Dockerfile  Multi-target image build (api, worker, web)
fixtures/                Synthetic identities and Project Atlas documents
docs/adr                 Architecture decisions (0001–0005)
scripts/smoke.mjs        End-to-end demonstration check over HTTP
scripts/lightrag-live-check.mjs  Live ACL-change / tombstone / deletion check against real LightRAG
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

Not implemented: OIDC, streaming, Microsoft Graph, MCP, actions/approvals,
workflows, the second agent, Playwright tests, backups. Those are later phases.
**Gate status:** source permission changes and deletion handling are proven
against the real, pinned **LightRAG** backend on synthetic data (ADR 0006).
Before adding broader company sources, decide whether one partition per
access set scales to the real ACL model, then run the 100–200 document
selection evaluation.
