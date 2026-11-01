# Search setup: where embeddings and answers run

The platform finds evidence in two ways (ADR 0010, ADR 0017):

- **By words** (always on): passages that contain the question's terms.
- **By meaning** (`EVIDENCE_SCORING=hybrid`): passages close to the question in an
  embedding model's vector space. This finds documents that use other words, for
  example "analytics platform" for a report that only says "Borealis".

Embedding models are small and cheap. `nomic-embed-text` has 137M parameters, runs
on a normal CPU, and embedded the whole 110-document eval corpus in 12 seconds.
Answer models are the expensive part. So the two can run in different places.

## Three setups

| Setup | Embeddings | Answer model | Document text that leaves the network | For |
|---|---|---|---|---|
| **Fully private** | local (Ollama, vLLM, TEI) | local | none | regulated customers with a GPU server for answers |
| **Split** (recommended default) | local | frontier model through an approved endpoint (`MODEL_MODE=hybrid`) | only the few passages each answer cites, never the whole corpus | most customers: no GPU needed |
| **Fully external** | external (e.g. Gemini) | external | every passage, once, for embedding | pilots on synthetic data |

Measured on the eval sets (supporting document in the top 5 with score ≥ 0.6):
`nomic-embed-text` local 90.7%, `gemini-embedding-001` 91%. Word matching alone: 65%.
The local model is nearly as good, so **Split** loses almost nothing against
**Fully external** for search.

## Settings

Split, with Ollama on the same host or network:

```bash
EVIDENCE_SCORING=hybrid
EMBEDDING_PROVIDER=ollama
EMBEDDING_BASE_URL=http://ollama:11434        # dev on the host: http://127.0.0.1:11434 (compose.lightrag.dev.yaml)
EMBEDDING_MODEL=nomic-embed-text
# Answers from a frontier model:
MODEL_MODE=hybrid
MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://…                      # also in MODEL_APPROVED_ENDPOINTS
```

Any OpenAI-compatible embedding server works (`EMBEDDING_PROVIDER=openai-compatible`,
`EMBEDDING_BASE_URL=http://vllm:8000/v1`). An embedding endpoint outside the private
network is refused unless `MODEL_MODE=hybrid` and it is in `MODEL_APPROVED_ENDPOINTS`
(https only), since embedding sends document text.

**Score calibration.** Each embedding model has its own similarity range. The platform
has measured values for `nomic-embed-text` and `gemini-embedding-001`
(`SCORE_CALIBRATION` in `packages/security/src/config.ts`). For another model, run the
calibration on the eval sets and set `SEMANTIC_SCORE_FLOOR` and `SEMANTIC_SCORE_CEIL`
so that about 90% of supporting documents score at least 0.6 (ADR 0017).

## Storage

- **Where:** passage embeddings are stored in the platform's PostgreSQL with the
  pgvector extension (table `passage_embeddings`). The migration runs
  `CREATE EXTENSION IF NOT EXISTS vector`. A database role that may not create
  extensions needs a DBA to run it once. Most managed PostgreSQL services offer pgvector.
- **When:** the worker embeds new and changed documents after each ingestion and
  after **Sync now**. Search embeds anything still missing, at most 25 documents per
  search.
- **Changes:** changing the embedding model re-embeds everything once. The old
  model's rows are not used.
- **Deletion:** a deleted document's vectors are deleted with it.

## Moving an existing dev database to the pgvector image

The Compose `postgres` service now uses `pgvector/pgvector` (Debian) on a new volume,
`postgres-vector-data`. The earlier Alpine image sorted text differently, so its volume
is not reused. Copy the data once:

```bash
export POSTGRES_PASSWORD=platform_dev
C="docker-compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml"
docker exec ai-platform-postgres-1 pg_dump -U platform -Fc platform > platform.dump   # before switching
$C up -d postgres                                                                     # new image, new volume
docker exec -i ai-platform-postgres-1 pg_restore -U platform -d platform --no-owner < platform.dump
pnpm db:migrate
```

The old volume (`ai-platform_postgres-data`) is left as it was. Delete it with
`docker volume rm ai-platform_postgres-data` once you no longer need it.
