# ADR 0003 — KnowledgeService, platform-owned ACL catalog, RAGFlow adapter

Status: accepted for Phase 1; **RAGFlow selection gate not yet passed** · Date: 2026-10-18

## Decision

- `KnowledgeService` (packages/knowledge) is the only retrieval entry point.
  `PolicyEnforcingKnowledgeService` resolves, before any adapter call:
  principal (reloaded from PostgreSQL) ∩ application policy sources ∩ agent
  scope ∩ document ACL. The adapter receives only authorized documents.
  Every returned chunk is re-checked; out-of-scope chunks are dropped and audited.
- The **platform owns the document catalog** (`source_documents`: source,
  version, ACL groups + revision, tombstone, adapter reference). The RAG backend
  is not trusted to enforce permissions.
- Evidence IDs are opaque (`ev_…`), recorded in `issued_evidence` per
  principal/run. Citations resolve only for the principal they were issued to,
  and only while current access still holds. Stored answers are re-checked on
  read and withheld if a cited document is no longer readable.
- Tombstones and ACL changes take effect in the next access check (catalog read
  per request; no caches yet).
- Adapters:
  - `FixtureKnowledgeAdapter`: deterministic lexical retrieval over
    `fixtures/documents`; scores only authorized chunks.
  - `RagflowKnowledgeAdapter`, pinned to **RAGFlow v0.27.2**, using
    `POST /api/v1/retrieval` with `document_ids` set to the authorized RAGFlow
    document IDs (backend prefilter). An empty list is never sent, because
    RAGFlow treats it as the whole dataset. Endpoint shapes come from
    `docs/references/http_api_reference.md` at that tag.

## Status of evidence

- Fixture adapter and policy service: covered by unit and HTTP tests.
- RAGFlow adapter: **mock HTTP tests only**. Not run against a live v0.27.2
  stack (blocked: 2 vCPU / 2 GiB Docker VM here vs. upstream ≥ 4 CPU / 16 GB).
  Retrieval quality, `document_ids` filtering correctness under load, parse
  behaviour and deletion propagation remain **unverified**.

## Open items before the selection gate

Real-stack contract test; revocation-after-index test; deletion of RAGFlow
documents/chunks on tombstone (async, tracked); 100–200 document corpus with
25–40 labeled questions; latency and resource measurements.
