# RAGFlow overlay (pinned: v0.27.2)

RAGFlow is not a single stateless container. Its upstream Compose stack runs
the RAGFlow server plus MySQL, Elasticsearch (or Infinity), MinIO and Redis.
We use the **upstream stack at the pinned tag unchanged** and attach the
platform to it, instead of re-modelling it here.

## Prerequisites (upstream guidance for v0.27.2)

- x86_64 or arm64 host, **≥ 4 CPU cores, ≥ 16 GB RAM, ≥ 50 GB disk**
- `vm.max_map_count >= 262144` on the Docker host (Elasticsearch)
- An embedding model configured in RAGFlow (local model service for local mode)

## Steps

```bash
# 1. Fetch the pinned upstream deployment files (gitignored).
infra/compose/ragflow/fetch.sh

# 2. Start the upstream stack (CPU profile, Elasticsearch doc engine).
docker compose -f infra/compose/ragflow/upstream/docker/docker-compose.yml \
  --env-file infra/compose/ragflow/upstream/docker/.env up -d

# 3. In the RAGFlow UI (http://localhost:80 by default): create an account,
#    configure an embedding model, create an empty dataset, and create an API key.

# 4. Start the platform with the overlay that joins the RAGFlow network.
export KNOWLEDGE_PROVIDER=ragflow RAGFLOW_BASE_URL=http://ragflow-cpu:9380 \
       RAGFLOW_API_KEY=... RAGFLOW_DATASET_ID=...
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  -f infra/compose/ragflow/compose.ragflow.yaml up -d --build

# 5. Upload + parse the synthetic fixtures and record RAGFlow IDs in the catalog.
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  -f infra/compose/ragflow/compose.ragflow.yaml run --rm ragflow-ingest

# 6. Run the smoke test against the RAGFlow-backed deployment.
SMOKE_BASE_URL=https://localhost:8443 pnpm smoke
```

Upstream v0.27.2 names the service `ragflow-cpu` (port `9380`) on network `ragflow`
(Compose project `docker`, so `docker_ragflow`). Confirm these against the fetched `docker-compose.yml`; adjust `compose.ragflow.yaml` if the
pinned release differs. This overlay has **not** been run in the milestone
environment (see the root README for the blocker).
