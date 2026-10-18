# Base images are pinned by digest; refresh deliberately (see docs/adr/0001).
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@12.9.1 --activate
WORKDIR /repo

# ---- deps: install with the frozen lockfile -------------------------------------
FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

# ---- build-server: compile API, worker and their workspace dependencies -------
FROM deps AS build-server
RUN pnpm exec turbo run build --filter=@platform/api... --filter=@platform/worker...

# ---- build-web: compile the Next.js app ------------------------------------------
FROM deps AS build-web
RUN pnpm exec turbo run build --filter=@platform/web...

# ---- prod: server tree without devDependencies ---------------------------------
FROM build-server AS prod
RUN pnpm install --frozen-lockfile --prod \
 && rm -rf apps/web packages/*/src apps/*/src agents/*/src .turbo

# ---- api ------------------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production FIXTURES_DIR=/repo/fixtures/documents
COPY --from=prod --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ---- worker (also runs migrate / seed as one-shot commands) --------------------
FROM base AS worker
ENV NODE_ENV=production FIXTURES_ROOT=/repo/fixtures
COPY --from=prod --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js", "start"]

# ---- web (Next.js standalone output) ---------------------------------------------
FROM base AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build-web --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build-web --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
