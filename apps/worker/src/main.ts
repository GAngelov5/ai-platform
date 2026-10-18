import { Queue, Worker } from "bullmq";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { pino } from "pino";
import { connectDatabase, createRepositories, runMigrations, waitFor } from "@platform/database";
import { ingestFixturesIntoRagflow, loadFixtureCorpus, RagflowClient } from "@platform/knowledge";
import { ConfigurationError, LOG_REDACT_PATHS, loadPlatformConfig, redactUrl } from "@platform/security";
import { seedFixtures } from "./seed.js";

const FIXTURES_ROOT = process.env.FIXTURES_ROOT ?? fileURLToPath(new URL("../../../fixtures", import.meta.url));
const QUEUE = "platform-maintenance";

function config(opts: { requireDatabase?: boolean; requireRedis?: boolean }) {
  try {
    return loadPlatformConfig(process.env, opts);
  } catch (err) {
    if (err instanceof ConfigurationError) {
      console.error(err.message);
      process.exit(78);
    }
    throw err;
  }
}

async function main() {
  const cmd = process.argv[2] ?? "start";
  const log = pino({ name: "worker", level: process.env.LOG_LEVEL ?? "info", redact: LOG_REDACT_PATHS });

  switch (cmd) {
    case "migrate": {
      const c = config({ requireDatabase: true });
      await waitFor("postgres", async () => {
        const h = connectDatabase(c.databaseUrl!, { max: 1 });
        try {
          await h.ping();
        } finally {
          await h.close();
        }
      });
      await runMigrations(c.databaseUrl!);
      log.info({ database: redactUrl(c.databaseUrl!) }, "migrations applied");
      return;
    }
    case "seed": {
      const c = config({ requireDatabase: true });
      if (c.env === "production") throw new Error("refusing to seed synthetic fixtures in production");
      const h = connectDatabase(c.databaseUrl!, { max: 1 });
      try {
        const r = await seedFixtures(h.db, FIXTURES_ROOT, c.customerId);
        log.info(r, "synthetic fixtures seeded");
      } finally {
        await h.close();
      }
      return;
    }
    case "ragflow-ingest": {
      const c = config({ requireDatabase: true });
      if (c.knowledge.provider !== "ragflow") throw new Error("set KNOWLEDGE_PROVIDER=ragflow and RAGFLOW_* to ingest");
      const k = c.knowledge;
      const h = connectDatabase(c.databaseUrl!, { max: 1 });
      try {
        const client = new RagflowClient({ baseUrl: k.baseUrl, apiKey: k.apiKey, timeoutMs: k.timeoutMs });
        const health = await client.healthz();
        if (!health.ok) throw new Error(`RAGFlow not healthy: ${health.detail}`);
        const repos = createRepositories(h.db);
        const docs = await loadFixtureCorpus(join(FIXTURES_ROOT, "documents"));
        await ingestFixturesIntoRagflow(client, k.datasetId, docs, {
          setExternalRef: (documentId, ref) => repos.catalog.setExternalRef(c.customerId, documentId, ref),
        }, (m) => log.info(m));
      } finally {
        await h.close();
      }
      return;
    }
    case "healthcheck": {
      const c = config({ requireRedis: true });
      const { Redis } = await import("ioredis");
      const r = new Redis(c.redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      await r.ping();
      await r.quit();
      return;
    }
    case "start": {
      const c = config({ requireDatabase: true, requireRedis: true });
      const connection = { url: c.redisUrl! };
      const h = connectDatabase(c.databaseUrl!, { max: 2 });
      await waitFor("postgres", h.ping);
      const repos = createRepositories(h.db);
      // Phase 1 shell: a single maintenance job that reports catalog health.
      // Ingestion, ACL synchronization and workflows are later phases; durable
      // workflow state will live in PostgreSQL, with BullMQ only dispatching.
      const worker = new Worker(
        QUEUE,
        async (job) => {
          if (job.name !== "catalog-report") throw new Error(`unknown job ${job.name}`);
          const docs = await repos.catalog.listAll(c.customerId);
          const report = { documents: docs.length, tombstoned: docs.filter((d) => d.tombstoned).length };
          log.info({ jobId: job.id, ...report }, "catalog report");
          return report;
        },
        { connection, concurrency: 1 },
      );
      worker.on("failed", (job, err) => log.error({ jobId: job?.id, err: err.message }, "job failed"));
      const queue = new Queue(QUEUE, { connection });
      await queue.upsertJobScheduler("catalog-report-hourly", { every: 60 * 60 * 1000 }, { name: "catalog-report" });
      log.info({ queue: QUEUE }, "worker started");
      const shutdown = async () => {
        await worker.close();
        await queue.close();
        await h.close();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      return;
    }
    default:
      throw new Error(`unknown command ${cmd} (migrate | seed | ragflow-ingest | healthcheck | start)`);
  }
}

main().catch((err) => {
  console.error(`worker: ${(err as Error).message}`);
  process.exit(1);
});
