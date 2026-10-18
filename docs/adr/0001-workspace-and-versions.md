# ADR 0001 — Workspace layout, toolchain and version policy

Status: accepted (Phase 1) · Date: 2026-10-18

## Decision

- pnpm workspace + Turborepo, TypeScript ESM (`module: nodenext`) everywhere.
- Node.js **24 LTS** (`.nvmrc`, `engines`), pnpm **12.9.1** via Corepack (`packageManager`).
- **Supply-chain guard**: `minimumReleaseAge: 20160` (14 days) in `pnpm-workspace.yaml`;
  dependency build scripts are deny-by-default (`allowBuilds`). The lockfile is the
  source of truth; Docker builds use `--frozen-lockfile`.
- Workspace packages export a private `@platform/source` condition pointing at
  `src/*.ts` (used by `tsc --noEmit`, Vitest and `tsx` dev runs) and `dist/*.js`
  for everything else. A unique name is required: a third-party package
  (`eventsource-parser`) also publishes a `source` condition.
- Container base images are pinned by digest in `infra/docker/Dockerfile` and
  `infra/compose/compose.yaml`.

## Resolved versions (lockfile, 2026-10-18)

| Area | Package | Version |
|---|---|---|
| Language | typescript | 7.0.2 (native compiler; `experimentalDecorators` verified for NestJS) |
| Build | turbo | 2.11.7 |
| API | @nestjs/core / common / platform-express | 12.1.2 (express 5.2.1) |
| Web | next / react | 16.3.8 / 19.3.0, tailwindcss 4.3.3 |
| Data | drizzle-orm / drizzle-kit / postgres | 0.45.3 / 0.31.11 / 3.4.9 |
| Models | ai / @ai-sdk/openai-compatible | 7.0.127 / 3.0.62 |
| Validation | zod | 4.6.5 |
| Queue | bullmq / ioredis | 6.3.11 / 5.11.1 |
| Logs | pino | 10.4.0 |
| Tests | vitest / @electric-sql/pglite | 5.0.3 / 0.5.8 |

Images: `node:24-bookworm-slim` (Node 24.22.0), `postgres:17-alpine` (17.11),
`valkey/valkey:8-alpine` (8.1.10), `caddy:2-alpine` (2.11.7). The Node image
digest was published 4 days before pinning (younger than the 14-day npm
policy); refresh deliberately.

## Consequences

- Next.js runs its own build with `typescript.ignoreBuildErrors` because the
  TS 7 native compiler is type-checked separately (`pnpm typecheck`).
- Vitest resolve conditions must not include `import`: it is applied to
  externalized CommonJS `require()` calls and broke Express's `router`.
- No shadcn/ui generator yet; components are hand-written Tailwind in `packages/ui`
  (shadcn adoption is a Phase 4 decision).
