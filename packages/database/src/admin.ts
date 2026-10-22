import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import * as schema from "./schema.js";

const { sourceDocuments, sourceSyncState, sourceQuarantine, actionProposals, workflows, workflowRuns, auditEvents, agentRuns } = schema;

/**
 * Read models for the admin console (ADR 0012). Operational metadata only:
 * counts, titles, states, errors and timestamps. Nothing here selects
 * document text, excerpts, message bodies or proposal payload values.
 */
export function createAdminQueries(db: Database) {
  return {
    /** Per source: catalog counts and how many documents the RAG backend holds (non-empty external ref). */
    async sourceCounts(customerId: string) {
      const rows = await db
        .select({
          sourceId: sourceDocuments.sourceId,
          documents: sql<number>`count(*) filter (where ${sourceDocuments.tombstonedAt} is null)`.mapWith(Number),
          tombstoned: sql<number>`count(*) filter (where ${sourceDocuments.tombstonedAt} is not null)`.mapWith(Number),
          indexed: sql<number>`count(*) filter (where ${sourceDocuments.tombstonedAt} is null and ${sourceDocuments.externalRef} <> '{}'::jsonb)`.mapWith(Number),
          unsearchable: sql<number>`count(*) filter (where ${sourceDocuments.tombstonedAt} is null and jsonb_array_length(${sourceDocuments.aclGroups}) = 0)`.mapWith(Number),
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.customerId, customerId))
        .groupBy(sourceDocuments.sourceId);
      return new Map(rows.map((r) => [r.sourceId, r]));
    },

    async syncStates(customerId: string) {
      const rows = await db.select().from(sourceSyncState).where(eq(sourceSyncState.customerId, customerId));
      return new Map(rows.map((r) => [r.sourceId, r]));
    },

    async quarantineCounts(customerId: string) {
      const rows = await db
        .select({ sourceId: sourceQuarantine.sourceId, n: sql<number>`count(*)`.mapWith(Number) })
        .from(sourceQuarantine)
        .where(eq(sourceQuarantine.customerId, customerId))
        .groupBy(sourceQuarantine.sourceId);
      return new Map(rows.map((r) => [r.sourceId, r.n]));
    },

    async quarantine(customerId: string, sourceId: string, limit = 200) {
      return db
        .select({
          externalId: sourceQuarantine.externalId,
          version: sourceQuarantine.version,
          reason: sourceQuarantine.reason,
          detail: sourceQuarantine.detail,
          createdAt: sourceQuarantine.createdAt,
        })
        .from(sourceQuarantine)
        .where(and(eq(sourceQuarantine.customerId, customerId), eq(sourceQuarantine.sourceId, sourceId)))
        .orderBy(desc(sourceQuarantine.createdAt))
        .limit(limit);
    },

    /** Records a "sync now" request; the worker runs it once it is newer than the source's last run. */
    async requestSync(customerId: string, sourceId: string, principalId: string, at: Date) {
      await db
        .insert(sourceSyncState)
        .values({ customerId, sourceId, syncRequestedAt: at, syncRequestedBy: principalId })
        .onConflictDoUpdate({
          target: [sourceSyncState.customerId, sourceSyncState.sourceId],
          set: { syncRequestedAt: at, syncRequestedBy: principalId, updatedAt: at },
        });
    },

    /** Marks requests made up to `startedAt` as handled (a request made during the run stays pending). */
    async clearSyncRequest(customerId: string, sourceId: string, startedAt: Date) {
      await db
        .update(sourceSyncState)
        .set({ syncRequestedAt: null, syncRequestedBy: null })
        .where(and(eq(sourceSyncState.customerId, customerId), eq(sourceSyncState.sourceId, sourceId), lt(sourceSyncState.syncRequestedAt, new Date(startedAt.getTime() + 1))));
    },

    /** Sources with a sync request newer than their last finished run. */
    async pendingSyncRequests(customerId: string): Promise<string[]> {
      const rows = await db.select().from(sourceSyncState).where(eq(sourceSyncState.customerId, customerId));
      return rows
        .filter((r) => r.syncRequestedAt && (!r.lastRun?.finishedAt || new Date(r.lastRun.finishedAt) < r.syncRequestedAt))
        .map((r) => r.sourceId);
    },

    async actionCounts(customerId: string) {
      const rows = await db
        .select({ state: actionProposals.state, n: sql<number>`count(*)`.mapWith(Number) })
        .from(actionProposals)
        .where(eq(actionProposals.customerId, customerId))
        .groupBy(actionProposals.state);
      return Object.fromEntries(rows.map((r) => [r.state, r.n])) as Record<string, number>;
    },

    /** All principals' proposals; payload values are withheld (only field names and the hash). */
    async actions(customerId: string, filter: { state?: string; limit?: number }) {
      const rows = await db
        .select()
        .from(actionProposals)
        .where(and(eq(actionProposals.customerId, customerId), filter.state ? eq(actionProposals.state, filter.state as schema.ActionStateValue) : undefined))
        .orderBy(desc(actionProposals.createdAt))
        .limit(Math.min(filter.limit ?? 100, 500));
      return rows.map((r) => ({
        id: r.id,
        principalId: r.principalId,
        state: r.state,
        capabilityId: r.capabilityId,
        connectorId: r.connectorId,
        operation: r.operation,
        destination: r.destination,
        origin: r.dedupeKey?.startsWith("wf:") ? ("workflow" as const) : ("conversation" as const),
        payloadFields: Object.keys(r.payload ?? {}).sort(),
        payloadHash: r.payloadHash,
        attempts: r.attempts,
        lastError: r.lastError,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        expiresAt: r.expiresAt,
        updatedAt: r.updatedAt,
      }));
    },

    async workflows(customerId: string) {
      const rows = await db.select().from(workflows).where(eq(workflows.customerId, customerId)).orderBy(desc(workflows.createdAt));
      const out = [];
      for (const w of rows) {
        const [last] = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, w.id)).orderBy(desc(workflowRuns.scheduledFor)).limit(1);
        const [{ failed24h } = { failed24h: 0 }] = await db
          .select({ failed24h: sql<number>`count(*)`.mapWith(Number) })
          .from(workflowRuns)
          .where(and(eq(workflowRuns.workflowId, w.id), eq(workflowRuns.status, "failed"), gte(workflowRuns.createdAt, new Date(Date.now() - 86_400_000))));
        out.push({
          id: w.id,
          principalId: w.principalId,
          kind: w.kind,
          kindVersion: w.kindVersion,
          config: w.config,
          intervalMinutes: w.intervalMinutes,
          enabled: w.enabled,
          nextRunAt: w.nextRunAt,
          createdAt: w.createdAt,
          lastRun: last ? { status: last.status, scheduledFor: last.scheduledFor, finishedAt: last.finishedAt, attempts: last.attempts, error: last.error } : null,
          failedLast24h: failed24h,
        });
      }
      return out;
    },

    /** Runs stuck "running" with a heartbeat older than `staleBefore` (a dead worker that nothing took over yet). */
    async staleWorkflowRuns(customerId: string, staleBefore: Date) {
      const [r] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.customerId, customerId), eq(workflowRuns.status, "running"), lt(workflowRuns.heartbeatAt, staleBefore)));
      return r?.n ?? 0;
    },

    async agentRunStats(customerId: string, since: Date) {
      const rows = await db
        .select({
          agentId: agentRuns.agentId,
          status: agentRuns.status,
          n: sql<number>`count(*)`.mapWith(Number),
          avgMs: sql<number>`coalesce(avg(extract(epoch from (${agentRuns.finishedAt} - ${agentRuns.startedAt})) * 1000), 0)`.mapWith(Number),
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.customerId, customerId), gte(agentRuns.startedAt, since)))
        .groupBy(agentRuns.agentId, agentRuns.status);
      const [running] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(agentRuns)
        .where(and(eq(agentRuns.customerId, customerId), isNull(agentRuns.finishedAt)));
      return { rows, running: running?.n ?? 0 };
    },

    /** Audit metadata (the table never holds content), newest first, with keyset paging by createdAt. */
    async audit(customerId: string, filter: { action?: string; principalId?: string; outcome?: string; before?: Date; limit?: number }) {
      return db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.customerId, customerId),
            filter.action ? sql`${auditEvents.action} like ${`${filter.action.replace(/[%_\\]/g, "")}%`}` : undefined,
            filter.principalId ? eq(auditEvents.principalId, filter.principalId) : undefined,
            filter.outcome ? eq(auditEvents.outcome, filter.outcome as "ok") : undefined,
            filter.before ? lt(auditEvents.createdAt, filter.before) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(Math.min(filter.limit ?? 100, 500));
    },
  };
}

export type AdminQueries = ReturnType<typeof createAdminQueries>;
