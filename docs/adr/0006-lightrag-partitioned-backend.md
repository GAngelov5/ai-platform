# ADR 0006 — LightRAG as the locally testable RAG backend, partitioned by access

Status: accepted for local/pilot evaluation · Date: 2026-10-19 · Amends ADR 0003

## Context

RAGFlow v0.27.2 ships x86-only images and needs ≥ 16 GB RAM for its full
stack. It could not be verified on the development Mac (Apple Silicon). The
owner asked for a backend that is testable in local Docker/Colima.
LightRAG v1.5.7 (HKUDS, MIT) ships a multi-arch image
(`ghcr.io/hkuds/lightrag:v1.5.7`) and runs as one container with file-based
storage. Its embedding and indexing models are served locally by Ollama.

Two properties of LightRAG matter for permissions:

1. Its query API (`/query`, `/query/data`) has **no per-document filter**.
2. It merges entity and relation descriptions **across all documents in a
   workspace** using an LLM, so a summary can blend text from documents with
   different access.

So filtering results after retrieval is not enough. That is the failure mode
the handoff calls out ("filtering an answer after generation is insufficient").

## Decision

- **One LightRAG server per access partition.** A partition holds only
  documents with the same `sourceId` and the **identical ACL group set**.
  This is the handoff's "physically separated collections with identical
  access membership". Workspaces are fixed per server process in v1.5.7, so
  each partition runs as its own container and volume
  (`infra/compose/lightrag/compose.lightrag.yaml`).
- Partitions are declared in config (`LIGHTRAG_PARTITIONS`, zod-validated):
  unique IDs, no two partitions with the same source and ACL, private-network
  URLs only. A document whose source and ACL match no partition is **not
  indexed** and so is not searchable. It fails closed and is reported by the sync.
- **Query path** (`LightRagKnowledgeAdapter`):
  - The policy service first resolves the authorized documents (unchanged).
  - A partition is queried only if an authorized document is placed there, and
    that document's *current* source and ACL still map to that partition.
    After an ACL change, a document is unsearchable everywhere until re-synced.
  - Only **verbatim chunks** are consumed (`data.chunks`). LightRAG's
    LLM-written entity and relation summaries are never passed on.
  - Each chunk must map back, through its version-specific `file_source`
    (`<documentId>__<version>.md`), to an authorized catalog document.
    Anything else is dropped.
  - LightRAG returns no relevance score. The platform scores chunks by query-term
    coverage, on the same scale as the fixture adapter, so the agent's
    `minEvidenceScore` gate (and abstention) behaves the same.
  - Default mode is `mix` (graph plus vector ranking), set with `LIGHTRAG_QUERY_MODE`.
- **Document view**: v1.5.7 has no "chunks of a document" endpoint. The
  protected view is served from the platform's own ingestion copy (fixtures
  here), after the same access check.
- **Sync** (`lightrag-sync`, `syncLightRagPartitions`) brings the catalog and
  partitions into line:
  - Inserts new or updated versions, and publishes the catalog reference only
    after `processed`.
  - Moves a document on ACL change: delete from the old partition, insert into
    the new one.
  - Deletes tombstoned or superseded content with `delete_llm_cache: true`.
  - Confirms each deletion before continuing. IDs are content-derived, so a
    re-insert of the same content reuses the ID.
  - Clears the reference of a document that failed to index.

  Access checks never depend on the sync having run.
- Hardening:
  - LightRAG runs as its non-root image user (uid 1000) with all capabilities
    dropped, on an internal `rag` network with no egress.
  - The API key is required on every route except `/health`.
  - Ollama has no egress at runtime. Only the one-shot `ollama-pull` job has
    internet access.

## Evidence (live, Colima 6 vCPU / 10 GiB, Apple Silicon)

- `pnpm smoke` against the LightRAG-backed stack: 12/12.
- `scripts/lightrag-live-check.mjs` (real containers): restricted memo only in
  the finance-legal partition; ACL change hides the document before sync and
  moves it after sync; tombstone hides immediately and is then physically
  purged (chunks, entities, relations, LLM cache), with deletion confirmed;
  restore re-indexes. See the README for the latest run.
- Indexing a small fixture with `qwen2.5:3b` on CPU takes about 30–90 s.
  `mix` queries take about 1–8 s per partition (partitions are queried in parallel).

## Consequences and limits

- One container per distinct (source, ACL) set. That works for a curated
  pilot source; for many ACL combinations it does not scale. Before broad
  sources, evaluate per-partition PostgreSQL workspaces, or a backend with a
  real document filter.
- Graph links never cross partitions. That is deliberate.
- Extraction quality with a 3B local model is low, and runaway output happened
  until `OLLAMA_LLM_NUM_PREDICT` was capped. A larger local model, or an
  approved hybrid endpoint, is a sizing decision for the pilot.
- One shared LightRAG API key for all partitions in dev. Use per-partition keys
  from the secret manager in a real deployment. LightRAG's graph-edit and
  document-admin routes must stay reachable only from the platform's internal
  network.
- Answer generation still uses the platform's ModelGateway. LightRAG's own
  `/query` generation is not used.
- The RAGFlow adapter stays in place (ADR 0003). Its live verification still
  needs an x86 host with ≥ 16 GB RAM.
