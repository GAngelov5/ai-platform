# ADR 0017 — Passage embeddings in PostgreSQL, and where models run

- Status: accepted
- Date: 2026-11-01
- Builds on: ADR 0010 (Decision 5, hybrid retrieval), ADR 0003 (policy-enforcing knowledge service)

## Questions

1. Hybrid retrieval (ADR 0010, Decision 5) embedded every authorized passage in API
   memory. The cache was lost on restart, and it doesn't scale. Where should embeddings live?
2. Should the best search depend on an external embedding service? Many customers
   can't run a frontier answer model on their own hardware. Do they also have to
   send their whole corpus out to get good search?

## Decision 1 — pgvector in the platform database

- **Table `passage_embeddings`:** one row per passage, embedding model and
  document version, plus an embedding `format`. The format names what was embedded
  (title, section and text), so changing it re-embeds.
  - The `vector` column has no fixed size, because each model has its own (768, 3072).
  - Rows cascade with the document's content. Tombstoning a document deletes its
    vectors in the same transaction.
- **Search reads only the authorized document versions.** The query joins
  `passage_embeddings` with the exact `(document_id, version)` list that the policy
  prefilter produced (`req.documents`). A passage of an unauthorized document, or of
  an older version, can't be returned.
  - The search is **exact** (no ANN index). Approximate indexes with filters can miss
    allowed rows silently, and exact search over the authorized subset is fast at
    pilot scale.
  - An HNSW index per model is the step when one access set holds hundreds of
    thousands of passages.
- **Filling:** the worker embeds new and changed documents after each ingestion and
  after Sync now (`embedNewDocuments`). Search embeds anything still missing, at most
  25 documents per search, and word matches in documents not yet embedded are
  embedded in memory. A failing embedding service never fails ingestion. At search
  time it fails closed, like a backend outage.
- **PostgreSQL image:** `pgvector/pgvector:0.8.1-pg17` (pinned by digest) on a new
  volume. The previous Alpine image sorted `en_US.utf8` text differently, so data is
  moved with `pg_dump`/`pg_restore` (docs/SEARCH-SETUP.md).
- **Tests:** PGlite with `@electric-sql/pglite-pgvector` 0.0.9, which matches PGlite 0.5.8.

## Decision 2 — Embeddings and answers may run in different places

Embedding models are small: `nomic-embed-text` (137M parameters) embedded the 110-document
eval corpus in 12 seconds on CPU in Docker. Answer models are the expensive part.
So a deployment chooses each independently (docs/SEARCH-SETUP.md):

| Setup | Embeddings | Answers | Document text sent out |
|---|---|---|---|
| Fully private | local | local | none |
| **Split** (recommended default) | local | frontier, approved endpoint | only the passages an answer uses |
| Fully external | external | external | every passage once |

An embedding endpoint outside the private network needs the same approval as the
answer model: `MODEL_MODE=hybrid`, listed in `MODEL_APPROVED_ENDPOINTS`, https.

**Calibration per model.** The cosine → score mapping is measured per embedding model
and mode, and built in for known models (`SCORE_CALIBRATION`). Env settings override it.

| Model | Mode | Floor / ceil | Supporting document in top 5, score ≥ 0.6 |
|---|---|---|---|
| nomic-embed-text (local) | hybrid | 0.35 / 0.70 | 90.7% |
| gemini-embedding-001 | hybrid | 0.50 / 0.85 | 91% |
| nomic-embed-text | semantic (Decision 4) | 0.15 / 0.90 | as ADR 0010 |
| word overlap only | — | — | 65% |

## Results — answers, 60 questions (answer model Gemini 3.5 Flash-Lite, judge Gemini 3.7 Flash)

| | Word overlap (2026-10-25) | Hybrid, Gemini embeddings | **Hybrid, local nomic embeddings (Split)** |
|---|---|---|---|
| Answerable answered (≥ 90%) | 78.3% | 87.0–89.1% | **97.8%** |
| Citation support (≥ 95%) | 90.2% | 96.8–100% | 93.3% |
| Unanswerable refused (100%) | 100% | 100% | 100% |
| Leaks (0) | 0 | 0 | 0 |
| Latency p50 | 2.1 s | 2.3 s | 1.7 s |

With local embeddings the model answers almost every reworded question. The sentences
judged unsupported are mostly those that link the user's term to the document's term
("the field service mobile app (Cedar)"). The cited passage states only one side.
Answer rate and strict citation pull against each other on loose rewordings. Runs also
vary: the same question can be answered in one run and refused in the next.

## Not covered (yet)

- An HNSW index for large access sets, and a load test at 100k+ passages.
- Re-embedding cost when the model changes on a large corpus (it runs on the worker,
  in the background, but isn't rate-limited yet).
- The bridging sentences above. Next: an answer rule to cite the passage that names
  the project, then re-run.
