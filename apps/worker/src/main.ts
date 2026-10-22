import { Queue, Worker } from "bullmq";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { pino } from "pino";
import { connectDatabase, createRepositories, runMigrations, waitFor } from "@platform/database";
import { ingestFixturesIntoRagflow, loadFixtureCorpus, loadSources, RagflowClient, syncLightRagPartitions, type LightRagPartition } from "@platform/knowledge";
import { buildIntegrations } from "@platform/actions";
import { fetchMcpToolPins } from "@platform/connectors";
import { ConfigurationError, LOG_REDACT_PATHS, loadPlatformConfig, mcpTokenVar, redactUrl } from "@platform/security";
import { WorkflowService } from "@platform/workflows";
import { seedFixtures } from "./seed.js";
import { ingestAll } from "./ingest.js";

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
        const r = await seedFixtures(h.db, FIXTURES_ROOT, c.customerId, c.ingestion.sourcesJson, { includeEvalCorpus: c.ingestion.includeEvalCorpus });
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
      // One connection holds the indexing lock; the other runs the queries.
      const h = connectDatabase(c.databaseUrl!, { max: 2 });
      try {
        log.info("waiting for the knowledge indexing lock (another ingest or sync may be running)");
        const run = await h.withLock(indexLock(c.customerId), () =>
          lightragSync(h.db, c.customerId, k.partitions, k.apiKey, k.timeoutMs, (m) => log.info(m)),
        );
        if (!run.acquired) throw new Error("indexing lock not acquired");
        const report = run.value;
        log.info(report, "lightrag sync complete");
        if (report.failed.length || !report.deletionVerified) process.exitCode = 2;
      } finally {
        await h.close();
      }
      return;
    }
    case "ingest": {
      const c = config({ requireDatabase: true });
      const h = connectDatabase(c.databaseUrl!, { max: 2 });
      try {
        await h.withLock(indexLock(c.customerId), async () => {
          const reports = await ingestAll(h.db, c.customerId, loadSources(c.ingestion.sourcesJson, FIXTURES_ROOT, { includeEvalCorpus: c.ingestion.includeEvalCorpus }), (m, d) => log.info(d ?? {}, m), process.argv[3]);
          for (const [id, r] of Object.entries(reports)) log.info({ source: id, ...r }, "ingestion complete");
          if (c.knowledge.provider === "lightrag" && process.argv.includes("--sync")) {
            const k = c.knowledge;
            const report = await lightragSync(h.db, c.customerId, k.partitions, k.apiKey, k.timeoutMs, (m) => log.info(m));
            log.info(report, "lightrag sync complete");
          }
        });
      } finally {
        await h.close();
      }
      return;
    }
    case "workflows-tick": {
      // One-shot: dispatch due workflows and execute runnable runs (manual testing, operators).
      const c = config({ requireDatabase: true });
      const h = connectDatabase(c.databaseUrl!, { max: 2 });
      try {
        const repos = createRepositories(h.db);
        const { actions, capabilities } = buildIntegrations({
          db: h.db,
          mcpServersJson: c.integrations.mcpServersJson,
          secret: (n) => process.env[n],
          tokenVar: mcpTokenVar,
          principals: repos.principals,
          audit: repos.audit,
          proposalTtlMinutes: c.integrations.proposalTtlMinutes,
          log: (msg, detail) => log.info(detail ?? {}, msg),
        });
        const workflows = new WorkflowService({ db: h.db, capabilities, actions, principals: repos.principals, audit: repos.audit, policyVersion: c.policyVersion, log: (m, d) => log.warn(d ?? {}, m) });
        log.info(await workflows.tick(), "workflow tick");
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
      // Three connections: a long sync holds one for the indexing lock.
      const h = connectDatabase(c.databaseUrl!, { max: 3 });
      await waitFor("postgres", h.ping);
      const repos = createRepositories(h.db);
      const sources = loadSources(c.ingestion.sourcesJson, FIXTURES_ROOT, { includeEvalCorpus: c.ingestion.includeEvalCorpus });
      const { actions, capabilities } = buildIntegrations({
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
      const workflows = new WorkflowService({
        db: h.db,
        capabilities,
        actions,
        principals: repos.principals,
        audit: repos.audit,
        policyVersion: c.policyVersion,
        log: (msg, detail) => log.warn(detail ?? {}, msg),
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
          if (job.name === "knowledge-ingest") {
            // Ingest and sync must never overlap with another ingest or sync (e.g. an
            // operator's one-shot run): concurrent syncs delete each other's inserts.
            const run = await h.withLock(
              indexLock(c.customerId),
              async () => {
                const reports = await ingestAll(h.db, c.customerId, sources, (m, d) => log.info(d ?? {}, m));
                const changed = Object.values(reports).some((r) => r.upserted || r.tombstoned || r.aclChanged);
                let sync: unknown = "skipped";
                // Reconcile on every run, not only after changes: a sync that hit its
                // deadline (large first index) must resume on the next run.
                if (c.knowledge.provider === "lightrag") {
                  const k = c.knowledge;
                  sync = await lightragSync(h.db, c.customerId, k.partitions, k.apiKey, k.timeoutMs, (m) => log.info(m));
                }
                log.info({ reports, sync }, "scheduled ingestion");
                return { sources: Object.keys(reports).length, changed };
              },
              { wait: false },
            );
            if (!run.acquired) {
              log.info("scheduled ingestion skipped: another ingest or sync holds the indexing lock");
              return { skipped: "busy" };
            }
            return run.value;
          }
          if (job.name === "workflow-tick") {
            // Dispatch due workflows and execute runnable runs (incl. ones a crashed worker left behind).
            const r = await workflows.tick();
            if (r.dispatched || r.succeeded || r.failed) log.info(r, "workflow tick");
            return r;
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
      await queue.upsertJobScheduler("workflow-tick", { every: 60 * 1000 }, { name: "workflow-tick" });
      await queue.upsertJobScheduler("knowledge-ingest", { every: c.ingestion.intervalMinutes * 60 * 1000 }, { name: "knowledge-ingest" });
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
      throw new Error(`unknown command ${cmd} (migrate | seed | ingest [sourceId] [--sync] | ragflow-ingest | lightrag-sync | workflows-tick | mcp-pins | healthcheck | start)`);
  }
}

/** One indexing run (ingest and/or RAG sync) per customer at a time, across processes. */
const indexLock = (customerId: string) => `knowledge-index:${customerId}`;

/** Converges LightRAG partitions with the catalog, reading text from the platform content store. */
async function lightragSync(db: ReturnType<typeof connectDatabase>["db"], customerId: string, partitions: LightRagPartition[], apiKey: string, timeoutMs: number, log: (m: string) => void) {
  const repos = createRepositories(db);
  return syncLightRagPartitions(
    partitions,
    { apiKey, timeoutMs },
    {
      listAll: () => repos.catalog.listAll(customerId),
      setExternalRef: (documentId, ref) => repos.catalog.setExternalRef(customerId, documentId, ref),
      content: async (doc) => {
        const r = await repos.content.get(customerId, doc.documentId);
        return r && r.version === doc.version ? r.text : undefined;
      },
    },
    log,
  );
}

main().catch((err) => {
  console.error(`worker: ${(err as Error).message}`);
  process.exit(1);
});
