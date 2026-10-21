import { Queue, Worker } from "bullmq";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { pino } from "pino";
import { connectDatabase, createRepositories, runMigrations, waitFor } from "@platform/database";
import { ingestFixturesIntoRagflow, loadFixtureCorpus, RagflowClient, syncLightRagPartitions } from "@platform/knowledge";
import { buildIntegrations } from "@platform/actions";
import { fetchMcpToolPins } from "@platform/connectors";
import { ConfigurationError, LOG_REDACT_PATHS, loadPlatformConfig, mcpTokenVar, redactUrl } from "@platform/security";
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
    case "lightrag-sync": {
      const c = config({ requireDatabase: true });
      if (c.knowledge.provider !== "lightrag") throw new Error("set KNOWLEDGE_PROVIDER=lightrag and LIGHTRAG_* to sync");
      const k = c.knowledge;
      const h = connectDatabase(c.databaseUrl!, { max: 1 });
      try {
        const repos = createRepositories(h.db);
        // Synthetic milestone: the ingestion copy of each document is the fixture file.
        const corpus = new Map((await loadFixtureCorpus(join(FIXTURES_ROOT, "documents"))).map((d) => [d.documentId, d]));
        const report = await syncLightRagPartitions(
          k.partitions,
          { apiKey: k.apiKey, timeoutMs: k.timeoutMs },
          {
            listAll: () => repos.catalog.listAll(c.customerId),
            setExternalRef: (documentId, ref) => repos.catalog.setExternalRef(c.customerId, documentId, ref),
            content: async (doc) => {
              const fx = corpus.get(doc.documentId);
              return fx && fx.version === doc.version ? fx.body : undefined;
            },
          },
          (m) => log.info(m),
        );
        log.info(report, "lightrag sync complete");
        if (report.failed.length || !report.deletionVerified) process.exitCode = 2;
      } finally {
        await h.close();
      }
      return;
    }
    case "mcp-pins": {
      // Operator review: print live tool definitions and their pin hashes.
      const url = process.argv[3];
      const id = process.argv[4] ?? "atlas-tracker";
      const token = process.env[mcpTokenVar(id)];
      if (!url || !token) throw new Error(`usage: mcp-pins <url> [serverId]  (requires ${mcpTokenVar(id)})`);
      const pins = await fetchMcpToolPins(url, token);
      console.log(JSON.stringify(Object.fromEntries(pins.map((p) => [p.name, p.sha256])), null, 2));
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
      const { actions } = buildIntegrations({
        db: h.db,
        mcpServersJson: c.integrations.mcpServersJson,
        secret: (n) => process.env[n],
        tokenVar: mcpTokenVar,
        principals: repos.principals,
        audit: repos.audit,
        proposalTtlMinutes: c.integrations.proposalTtlMinutes,
        onSecurityEvent: (type, detail) => log.warn({ securityEvent: type, ...detail }, "security event"),
        log: (msg, detail) => log.info(detail ?? {}, msg),
      });
      // Durable state lives in PostgreSQL. BullMQ only schedules maintenance;
      // action execution is driven by the transactional outbox.
      const worker = new Worker(
        QUEUE,
        async (job) => {
          if (job.name === "catalog-report") {
            const docs = await repos.catalog.listAll(c.customerId);
            const report = { documents: docs.length, tombstoned: docs.filter((d) => d.tombstoned).length };
            log.info({ jobId: job.id, ...report }, "catalog report");
            return report;
          }
          if (job.name === "action-maintenance") {
            const expired = await actions.expireStale();
            const recovered = await actions.recoverInterrupted();
            if (expired || recovered) log.info({ expired, recovered }, "action maintenance");
            return { expired, recovered };
          }
          throw new Error(`unknown job ${job.name}`);
        },
        { connection, concurrency: 1 },
      );
      worker.on("failed", (job, err) => log.error({ jobId: job?.id, err: err.message }, "job failed"));
      const queue = new Queue(QUEUE, { connection });
      await queue.upsertJobScheduler("catalog-report-hourly", { every: 60 * 60 * 1000 }, { name: "catalog-report" });
      await queue.upsertJobScheduler("action-maintenance", { every: 60 * 1000 }, { name: "action-maintenance" });
      await actions.recoverInterrupted(0); // anything 'executing' at startup was interrupted
      let stopping = false;
      const outboxLoop = (async () => {
        while (!stopping) {
          try {
            const n = await actions.processOutbox(10);
            if (n) log.info({ processed: n }, "outbox events processed");
          } catch (err) {
            log.error({ err: (err as Error).message }, "outbox loop error");
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      })();
      log.info({ queue: QUEUE }, "worker started");
      const shutdown = async () => {
        stopping = true;
        await outboxLoop;
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
      throw new Error(`unknown command ${cmd} (migrate | seed | ragflow-ingest | lightrag-sync | mcp-pins | healthcheck | start)`);
  }
}

main().catch((err) => {
  console.error(`worker: ${(err as Error).message}`);
  process.exit(1);
});
