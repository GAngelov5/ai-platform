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
| 3b · Knowledge selection gate *(retrieval part)* | PDF/DOCX parsing in an isolated worker thread, 110-file synthetic corpus, 34 labeled questions, HTTP eval harness (base + hard sets), platform-side version handling, optional semantic evidence score | ADR 0010 · `docs/eval/` (lexical + LightRAG) · 113 tests |
| 3c · Second agent and workflow | Meeting Preparation Assistant (definition only) with a synthetic calendar MCP; durable scheduled status-check workflow (PostgreSQL state, BullMQ trigger, deduplicated proposals, one approval per write); Inbox → Scheduled checks | ADR 0011 · 129 tests · `scripts/stage3c-live-check.mjs` |

## Next

1. **Stage 2 · Microsoft 365** *(blocked: needs a test tenant and an Entra app
   registration)*
   - Graph connector for live mail and calendar, and `email.createDraft`
     through approvals.
   - SharePoint source adapter (Graph delta queries), on the ADR 0009 pipeline.
   - Personal-account connect flow behind "Your connections".
2. **Stage 3b, rest**
   - **Evidence score:** semantic scoring (`EVIDENCE_SCORING=semantic`) cut
     wrong refusals on the hard set from 64.7% to 0% with LightRAG. But the
     platform then no longer refuses off-topic questions; the model must.
     Next: try a cross-encoder re-ranker, and decide the default after the
     answer-level gate (ADR 0010, Decision 4).
   - **Answer-level gate:** citation support ≥ 95% and model-level abstention.
     This needs real model answers, and waits for the model and hardware
     decision below.
   - OCR for scans.
3. **Admin console:** sources (sync status, quarantine), integrations (pins,
   requests), action operator queue, runs and audit. Designed on the canvas,
   not built.
4. **Stage 4 · Production hardening:** OIDC, secrets manager, image slimming
   and scanning, egress tests in CI, backup and restore drills,
   OpenTelemetry, Playwright.
5. **Stage 5 · Customer packaging:** runbooks, a second customer
   configuration, supervised pilot.

## Notes from the last stage (to check)

**Stage 3c**
- **Live check (2026-10-22):** the workflow and permission checks all pass
  on the real stack (14/14). The worker ran a new check within 45 s, the
  change to Blocked was proposed exactly once, an unchanged run proposed
  nothing, and the approved proposal executed.
- **Real-model briefings fail on CPU** (`qwen3:4b`).
  - The routing was right: both runs called the calendar first, and
    Alice's also checked both agenda tasks in the tracker.
  - But Alice's run hit the 10-minute limit before searching documents.
  - Bob's model wrote an answer without valid citations, so the runtime
    abstained, as designed.
  - The same agent passes with the deterministic model (tests). This is the
    open model and hardware decision, not a platform defect.
- The second agent is a definition plus eval cases. The platform needed two
  general additions:
  - live reads now receive the trusted caller, so a personal calendar is
    read only for the signed-in user (the same contract Stage 2's Graph
    needs)
  - a calendar capability binding
- Workflow writes are deduplicated by key, so retries, takeovers and later
  runs never produce a second approval for the same change.
- "Your connections" now lists capabilities across all agents, so the
  calendar appears there.
- The dev worker bind-mounts `fixtures/sources` read-only, so ingestion can
  be tested by editing files ([MANUAL-TESTING.md](MANUAL-TESTING.md) §6).
- **Manual testing guide:** [MANUAL-TESTING.md](MANUAL-TESTING.md) covers
  every stage so far.

**Stage 3b**

- **Superseded versions ranked first.** The first lexical run put every
  go-live plan v1 above its v2 (0% current-first).
  - Fixed in the platform, so it applies to every backend: version families
    by file name, superseded chunks demoted, and the evidence labeled
    `supersededBy`. Now 100%.
  - Families are computed only over documents the user can read, so an
    unreadable v2 is never revealed.
- **Semantic evidence score** (Ollama `nomic-embed-text`, calibrated):
  false abstention on the hard set dropped from 64.7% to 0% (LightRAG). No
  cosine threshold refuses near-misses: they score *higher* than real
  answers. Off-topic questions score 0.65–0.73. The threshold is calibrated
  for no wrong refusals, and abstention is left to the model.
- **Hard question set** (paraphrases, multi-document, near-misses): no
  backend passes. LightRAG with lexical re-ranking is best at 70.6% recall;
  lexical is 52.9%. Alias questions ("the HR self-service launch" for Ember)
  fail on every backend.
- **LightRAG results** (eval overlay, 105 documents indexed): 100% recall,
  100% current-version-first, 0 leaks, 80% abstention (q29). Native LightRAG
  ranking (`LIGHTRAG_RANKING=native`) and lexical re-ranking score the same.
  Search latency is 13–23 s per uncached query on CPU, because LightRAG
  extracts query keywords with the LLM.
- **Ollama runner crashed once** under memory pressure: queries ran while a
  partition was still extracting. Retried searches succeeded. The eval now
  retries a 503 once and reports it.
- **Abstention cannot come from a score threshold.** "Per diem for travel to
  the Moon" matches the travel policy on 3 of 4 terms, which is higher than
  several real questions.
  - IDF weighting was tried: it did not fix q29, and it caused 23% false
    abstention. Reverted.
  - Refusing near-miss questions is the model's job; measure it with real
    answers.
- **Scans:** the 3 image-only PDFs, and the team-share architecture diagram,
  are quarantined as `needs_ocr`.
- **Version handling, first attempt corrected.** Halving superseded scores
  overrode the backend's order and pushed old versions below the evidence
  threshold. Now superseded chunks just move after current ones.
- **Bug found and fixed: overlapping syncs.** A one-shot `lightrag-sync` and
  the worker's scheduled ingest → sync ran at the same time, and each
  deleted the other's inserts (96 of 105 documents failed). Ingest and sync
  now hold a per-customer PostgreSQL advisory lock. Seen working live: a
  scheduled run fired mid-sync and skipped as busy. The scheduled job skips
  when the lock is busy, and one-shot commands wait for it. Checked on the
  dev database.
- **Bug found and fixed: an interrupted sync never resumed.** The first sync
  of 105 documents hit its 30-minute deadline after 55. The scheduler synced
  only when ingestion changed something, so the rest would never have been
  indexed. The scheduled job now reconciles on every run. The sync is
  idempotent, and cheap when nothing is pending.
- **Bug found and fixed: unstable folder versions.** The version was mtime in
  milliseconds plus size, but copies in a container image keep only whole
  seconds. So the same file ingested on the host and in the container got
  two versions, and was re-indexed. The version is now truncated to whole
  seconds.
- **The eval corpus is opt-in.** Set `KNOWLEDGE_INCLUDE_EVAL_CORPUS`, or stack
  `compose.lightrag-eval.yaml`; production refuses both. If the overlay is
  dropped, the next sync purges the eval documents from LightRAG.

## Decisions waiting for you

- **Model size and speed.** `qwen3:4b` on CPU takes 2–6 minutes per answer.
  Options: a GPU host, or Ollama natively with Metal on the Mac, or a larger
  model.
- **Microsoft 365 test tenant**, to unblock Stage 2.
- **Partition scale** (ADR 0006/0009): how many distinct access sets will the
  first real source have?
- **OCR and a parser container:** Tesseract or docling in a no-network
  parser container, or the RAG backend's parser (ADR 0010).
- **Retention** of the content store and quarantine after source deletions.

## How to check the current state

Step-by-step manual checks for every stage: [MANUAL-TESTING.md](MANUAL-TESTING.md).

```bash
pnpm typecheck && pnpm test
SMOKE_BASE_URL=https://localhost:8443 SMOKE_INSECURE_TLS=1 pnpm smoke
SMOKE_INSECURE_TLS=1 node scripts/lightrag-live-check.mjs
SMOKE_INSECURE_TLS=1 node scripts/integration-live-check.mjs
EVAL_BASE_URL=https://localhost:8443 SMOKE_INSECURE_TLS=1 EVAL_LABEL=lightrag node scripts/eval-retrieval.mjs
SMOKE_INSECURE_TLS=1 WITH_MODEL=1 node scripts/stage3c-live-check.mjs
```
