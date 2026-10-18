# ADR 0005 — Docker Compose packaging for a supervised single-host pilot

Status: accepted (Phase 1) · Date: 2026-10-18

## Decision

- Base stack (`infra/compose/compose.yaml`): Caddy TLS proxy (only published
  port, bound to 127.0.0.1:8443 by default), web, API, worker, one-shot
  `migrate`, PostgreSQL 17, Valkey 8.
- Networks: `edge` (proxy, web, API) and `backend` (`internal: true`: API,
  worker, PostgreSQL, Valkey; no outbound route). The development overlay adds
  a separate `devhost` network only to publish localhost debug ports, because
  Docker does not publish ports for containers attached only to internal networks.
- Migrations run as a controlled step (`migrate` must complete before API and
  worker start). Apps also retry dependencies (`waitFor`); container order is
  not treated as readiness. Health/readiness checks on API, web, worker and data
  services.
- Hardening: read-only root filesystems, `no-new-privileges`, all capabilities
  dropped, non-root `node` user for app images, resource limits, restart policies.
  **Exception:** the Caddy container runs as the image's default user with only
  `NET_BIND_SERVICE`, because its binary carries a file capability that cannot be
  exec'd as non-root under `no-new-privileges`.
- **Valkey instead of Redis**: BullMQ-compatible, BSD-licensed. Avoids
  re-licensing questions for on-prem commercial packaging. Revisit if the
  customer standardizes on Redis.
- RAGFlow is an **overlay that attaches to the unmodified upstream stack** at
  the pinned tag (`infra/compose/ragflow/`), not a single container.
- Secrets come from the environment/secret manager at runtime. `POSTGRES_PASSWORD`
  is mandatory (`:?`), nothing is baked into images.

## Known limitations

- API/worker images are ~1.1 GB (full workspace prod tree). Use `pnpm deploy`
  or a bundler to slim them before the pilot.
- The Dockerfile avoids BuildKit-only features because the local Docker CLI had
  no buildx plugin. Re-enable cache mounts when BuildKit is available.
- Caddy uses its internal CA (`tls internal`). Customer certificates are a
  deployment step.
- No backups, restore drill, log shipping or HA. Compose targets a supervised
  single-host pilot.
