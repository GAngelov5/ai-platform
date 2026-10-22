# Roadmap and status

A living document: what is done, what is next, and the decisions waiting for
you. Each finished stage links to its evidence (ADR, tests, live checks).

Last updated: 2026-10-22

## Done

| Stage | What | Evidence |
|---|---|---|
| 1 · Foundation | Monorepo, NestJS API, Next.js web, worker, PostgreSQL, Compose with TLS, `TrustedContext`, dev identities, CSRF | ADR 0001, 0002, 0005 · `pnpm smoke` |
| 1 · Knowledge slice | Policy-enforcing `KnowledgeService`, catalog ACLs, citations, abstention | ADR 0003 · API tests |
| 2a · Real RAG backend | LightRAG v1.5.7 partitioned by access, Ollama local models, sync with confirmed deletion | ADR 0006 · `scripts/lightrag-live-check.mjs` (19/19) |
| Stage 1 · Integrations | Context router, capability registry, MCP client with pinned tools, approvals, outbox, reconciliation, SSE | ADR 0007, 0008 · `scripts/integration-live-check.mjs` |
| UI · Forest design | Workspace with context panel, Inbox, account menu, Your connections | commit 51c3d73 · design canvas |
| 3a · Source ingestion | `SourceAdapter` contract, generic pipeline, folder adapter with inherited ACLs, quarantine, content store, partitions per access set, scheduled ingest → sync | ADR 0009 · 98 tests · `scripts/lightrag-live-check.mjs` (23/23, 2026-10-22) |

## Next

1. **Stage 2 · Microsoft 365** *(blocked: needs a test tenant and an Entra app
   registration)*
   - Graph connector for live mail and calendar, and `email.createDraft`
     through approvals.
   - SharePoint source adapter (Graph delta queries), on the ADR 0009 pipeline.
   - Personal-account connect flow behind "Your connections".
2. **Stage 3b · Knowledge selection gate**
   - Corpus of 100–200 synthetic documents (PDF, DOCX, scans, conflicting
     versions) and 25–40 labeled questions.
   - Targets: top-5 recall ≥ 85%, citation support ≥ 95%, abstention 100%,
     zero leaks.
   - PDF/DOCX parser upgrade.
3. **Stage 3c · Second agent and workflow:** Meeting Preparation Assistant,
   plus the durable scheduled status-check workflow.
4. **Admin console:** sources (sync status, quarantine), integrations (pins,
   requests), action operator queue, runs and audit. Designed on the canvas,
   not built.
5. **Stage 4 · Production hardening:** OIDC, secrets manager, image slimming
   and scanning, egress tests in CI, backup and restore drills,
   OpenTelemetry, Playwright.
6. **Stage 5 · Customer packaging:** runbooks, a second customer
   configuration, supervised pilot.

## Notes from the last stage (to check)

- **Real share:** permissions are inherited from `.acl.json` files.
  - The four share documents landed in the existing three access-set
    partitions, so no new containers were needed.
  - The contractor file (unmapped group) was catalogued but never indexed.
  - The PDF is quarantined as `unsupported_type`.
- **Scheduled ingestion** ran on worker start and ingested every source.
- **Bug found and fixed:** the long-running worker had no LightRAG settings,
  so its scheduled sync was skipped (it reported "skipped"). It now gets them
  through the LightRAG overlay.
- **Live check changed:** `lightrag-live-check.mjs` now checks retrieval
  directly. Full real-model answers take more than 5 minutes on CPU, and
  answer quality is covered by `integration-live-check.mjs`.

## Decisions waiting for you

- **Model size and speed.** `qwen3:4b` on CPU takes 2–6 minutes per answer.
  Options: a GPU host, or Ollama natively with Metal on the Mac, or a larger
  model.
- **Microsoft 365 test tenant**, to unblock Stage 2.
- **Partition scale** (ADR 0006/0009): how many distinct access sets will the
  first real source have?
- **Document parsing:** self-hosted Tika or docling, or the RAG backend's
  parser.
- **Retention** of the content store and quarantine after source deletions.

## How to check the current state

```bash
pnpm typecheck && pnpm test
SMOKE_BASE_URL=https://localhost:8443 SMOKE_INSECURE_TLS=1 pnpm smoke
SMOKE_INSECURE_TLS=1 node scripts/lightrag-live-check.mjs
SMOKE_INSECURE_TLS=1 node scripts/integration-live-check.mjs
```
