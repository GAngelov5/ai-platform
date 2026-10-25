import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  agentRuns,
  auditEvents,
  conversations,
  documentContent,
  issuedEvidence,
  liveEvidence,
  messages,
  oauthStates,
  personalConnections,
  principals,
  sessions,
  sourceDocuments,
  sourceQuarantine,
  sourceSyncState,
  toolCalls,
  type SourceRunReport,
  type StoredCitation,
  type StoredToolCall,
} from "./schema.js";

export interface LiveEvidenceRecord {
  evidenceId: string;
  customerId: string;
  principalId: string;
  runId: string;
  connectorId: string;
  capabilityId: string;
  resourceId: string;
  title: string;
  excerpt: string;
  readAt: Date;
}

export interface ToolCallRecord {
  runId: string;
  customerId: string;
  principalId: string;
  capabilityId: string;
  capabilityVersion: string;
  kind: "read" | "write";
  status: string;
  argsHash?: string;
  errorKind?: string;
  durationMs: number;
}

export interface PrincipalRecord {
  id: string;
  customerId: string;
  displayName: string;
  description: string;
  groups: string[];
  roles: string[];
  origin: "fixture" | "oidc";
  disabled: boolean;
}

export interface CatalogRecord {
  customerId: string;
  documentId: string;
  sourceId: string;
  version: string;
  title: string;
  sourceUrl?: string;
  aclGroups: string[];
  aclRevision: number;
  externalRef: Record<string, string>;
  indexedAt: Date;
  tombstoned: boolean;
}

export interface IssuedEvidenceRecord {
  evidenceId: string;
  customerId: string;
  principalId: string;
  runId: string | null;
  requestId: string;
  sourceId: string;
  documentId: string;
  version: string;
  chunkId: string;
  title: string;
  location?: string;
  sourceUrl?: string;
  indexedAt: Date;
  excerpt: string;
}

export interface AuditInput {
  customerId: string;
  principalId?: string | null;
  requestId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome: "allowed" | "denied" | "error" | "ok";
  detail?: Record<string, unknown>;
}

const toPrincipal = (r: typeof principals.$inferSelect): PrincipalRecord => ({
  id: r.id,
  customerId: r.customerId,
  displayName: r.displayName,
  description: r.description,
  groups: r.groups,
  roles: r.roles,
  origin: r.origin,
  disabled: r.disabled,
});

const toCatalog = (r: typeof sourceDocuments.$inferSelect): CatalogRecord => ({
  customerId: r.customerId,
  documentId: r.documentId,
  sourceId: r.sourceId,
  version: r.version,
  title: r.title,
  sourceUrl: r.sourceUrl ?? undefined,
  aclGroups: r.aclGroups,
  aclRevision: r.aclRevision,
  externalRef: r.externalRef,
  indexedAt: r.indexedAt,
  tombstoned: r.tombstonedAt !== null,
});

export function createRepositories(db: Database) {
  return {
    principals: {
      async get(customerId: string, principalId: string): Promise<PrincipalRecord | undefined> {
        const [row] = await db
          .select()
          .from(principals)
          .where(and(eq(principals.customerId, customerId), eq(principals.id, principalId)));
        return row ? toPrincipal(row) : undefined;
      },
      async listByOrigin(customerId: string, origin: "fixture" | "oidc"): Promise<PrincipalRecord[]> {
        const rows = await db
          .select()
          .from(principals)
          .where(and(eq(principals.customerId, customerId), eq(principals.origin, origin)))
          .orderBy(asc(principals.id));
        return rows.map(toPrincipal);
      },
      async setRoles(customerId: string, principalId: string, roles: string[]): Promise<void> {
        await db
          .update(principals)
          .set({ roles })
          .where(and(eq(principals.customerId, customerId), eq(principals.id, principalId)));
      },
      async setGroups(customerId: string, principalId: string, groups: string[]): Promise<void> {
        await db
          .update(principals)
          .set({ groups })
          .where(and(eq(principals.customerId, customerId), eq(principals.id, principalId)));
      },
    },

    sessions: {
      async create(input: { tokenHash: string; customerId: string; principalId: string; authMode: "dev" | "oidc"; expiresAt: Date }) {
        const [row] = await db.insert(sessions).values(input).returning({ id: sessions.id });
        return row!.id;
      },
      async findActive(tokenHash: string, now = new Date()) {
        const [row] = await db
          .select()
          .from(sessions)
          .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)));
        return row;
      },
      async revoke(tokenHash: string): Promise<void> {
        await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, tokenHash));
      },
    },

    catalog: {
      async listReadable(customerId: string, groups: readonly string[], sourceIds: readonly string[]): Promise<CatalogRecord[]> {
        if (groups.length === 0 || sourceIds.length === 0) return [];
        const rows = await db
          .select()
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.customerId, customerId),
              inArray(sourceDocuments.sourceId, [...sourceIds]),
              isNull(sourceDocuments.tombstonedAt),
            ),
          );
        // ACL intersection is evaluated again by the policy layer; this is the prefilter.
        return rows.map(toCatalog).filter((d) => d.aclGroups.some((g) => groups.includes(g)));
      },
      async get(customerId: string, documentId: string): Promise<CatalogRecord | undefined> {
        const [row] = await db
          .select()
          .from(sourceDocuments)
          .where(and(eq(sourceDocuments.customerId, customerId), eq(sourceDocuments.documentId, documentId)));
        return row ? toCatalog(row) : undefined;
      },
      async listAll(customerId: string): Promise<CatalogRecord[]> {
        const rows = await db.select().from(sourceDocuments).where(eq(sourceDocuments.customerId, customerId));
        return rows.map(toCatalog);
      },
      async upsert(doc: Omit<CatalogRecord, "tombstoned" | "aclRevision"> & { contentHash: string }): Promise<void> {
        const values = {
          customerId: doc.customerId,
          documentId: doc.documentId,
          sourceId: doc.sourceId,
          version: doc.version,
          title: doc.title,
          sourceUrl: doc.sourceUrl ?? null,
          aclGroups: doc.aclGroups,
          contentHash: doc.contentHash,
          externalRef: doc.externalRef,
          indexedAt: doc.indexedAt,
          tombstonedAt: null,
          updatedAt: new Date(),
        };
        await db
          .insert(sourceDocuments)
          .values(values)
          .onConflictDoUpdate({ target: [sourceDocuments.customerId, sourceDocuments.documentId], set: values });
      },
      async setAcl(customerId: string, documentId: string, aclGroups: string[]): Promise<void> {
        const current = await this.get(customerId, documentId);
        if (!current) return;
        await db
          .update(sourceDocuments)
          .set({ aclGroups, aclRevision: current.aclRevision + 1, updatedAt: new Date() })
          .where(and(eq(sourceDocuments.customerId, customerId), eq(sourceDocuments.documentId, documentId)));
      },
      async setExternalRef(customerId: string, documentId: string, externalRef: Record<string, string>): Promise<void> {
        await db
          .update(sourceDocuments)
          .set({ externalRef, updatedAt: new Date() })
          .where(and(eq(sourceDocuments.customerId, customerId), eq(sourceDocuments.documentId, documentId)));
      },
      /** Takes effect in access checks immediately; derived index cleanup is asynchronous. */
      async tombstone(customerId: string, documentId: string): Promise<void> {
        await db
          .update(sourceDocuments)
          .set({ tombstonedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(sourceDocuments.customerId, customerId), eq(sourceDocuments.documentId, documentId)));
      },
    },

    evidence: {
      async record(rows: IssuedEvidenceRecord[]): Promise<void> {
        if (rows.length === 0) return;
        await db.insert(issuedEvidence).values(
          rows.map((r) => ({ ...r, location: r.location ?? null, sourceUrl: r.sourceUrl ?? null })),
        );
      },
      async get(customerId: string, evidenceId: string): Promise<IssuedEvidenceRecord | undefined> {
        const [row] = await db
          .select()
          .from(issuedEvidence)
          .where(and(eq(issuedEvidence.customerId, customerId), eq(issuedEvidence.evidenceId, evidenceId)));
        if (!row) return undefined;
        return { ...row, location: row.location ?? undefined, sourceUrl: row.sourceUrl ?? undefined };
      },
    },

    content: {
      async put(row: { customerId: string; documentId: string; version: string; mimeType: string; text: string; contentHash: string }): Promise<void> {
        await db
          .insert(documentContent)
          .values(row)
          .onConflictDoUpdate({
            target: [documentContent.customerId, documentContent.documentId],
            set: { version: row.version, mimeType: row.mimeType, text: row.text, contentHash: row.contentHash, updatedAt: new Date() },
          });
      },
      async get(customerId: string, documentId: string) {
        const [row] = await db
          .select()
          .from(documentContent)
          .where(and(eq(documentContent.customerId, customerId), eq(documentContent.documentId, documentId)));
        return row;
      },
    },

    sources: {
      async getState(customerId: string, sourceId: string) {
        const [row] = await db
          .select()
          .from(sourceSyncState)
          .where(and(eq(sourceSyncState.customerId, customerId), eq(sourceSyncState.sourceId, sourceId)));
        return row;
      },
      async saveState(customerId: string, sourceId: string, cursor: string | null, lastRun: SourceRunReport): Promise<void> {
        await db
          .insert(sourceSyncState)
          .values({ customerId, sourceId, cursor, lastRun })
          .onConflictDoUpdate({ target: [sourceSyncState.customerId, sourceSyncState.sourceId], set: { cursor, lastRun, updatedAt: new Date() } });
      },
      async quarantine(row: { customerId: string; sourceId: string; externalId: string; version: string; reason: string; detail?: string }): Promise<void> {
        await db
          .insert(sourceQuarantine)
          .values({ ...row, detail: row.detail ?? null })
          .onConflictDoUpdate({
            target: [sourceQuarantine.customerId, sourceQuarantine.sourceId, sourceQuarantine.externalId],
            set: { version: row.version, reason: row.reason, detail: row.detail ?? null, createdAt: new Date() },
          });
      },
      async release(customerId: string, sourceId: string, externalId: string): Promise<void> {
        await db
          .delete(sourceQuarantine)
          .where(and(eq(sourceQuarantine.customerId, customerId), eq(sourceQuarantine.sourceId, sourceId), eq(sourceQuarantine.externalId, externalId)));
      },
      async listQuarantinedVersions(customerId: string, sourceId: string) {
        return db
          .select({ externalId: sourceQuarantine.externalId, version: sourceQuarantine.version })
          .from(sourceQuarantine)
          .where(and(eq(sourceQuarantine.customerId, customerId), eq(sourceQuarantine.sourceId, sourceId)));
      },
      async listQuarantine(customerId: string, sourceId?: string) {
        return db
          .select()
          .from(sourceQuarantine)
          .where(sourceId ? and(eq(sourceQuarantine.customerId, customerId), eq(sourceQuarantine.sourceId, sourceId)) : eq(sourceQuarantine.customerId, customerId));
      },
    },

    liveEvidence: {
      async record(rows: LiveEvidenceRecord[]): Promise<void> {
        if (rows.length) await db.insert(liveEvidence).values(rows);
      },
      async get(customerId: string, evidenceId: string): Promise<LiveEvidenceRecord | undefined> {
        const [row] = await db
          .select()
          .from(liveEvidence)
          .where(and(eq(liveEvidence.customerId, customerId), eq(liveEvidence.evidenceId, evidenceId)));
        return row;
      },
    },

    toolCalls: {
      async record(row: ToolCallRecord): Promise<void> {
        await db.insert(toolCalls).values({ ...row, argsHash: row.argsHash ?? null, errorKind: row.errorKind ?? null });
      },
      async listForRun(runId: string) {
        return db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).orderBy(asc(toolCalls.createdAt));
      },
    },

    conversations: {
      async create(input: { customerId: string; ownerPrincipalId: string; agentId: string; title: string }) {
        const [row] = await db.insert(conversations).values(input).returning();
        return row!;
      },
      /** Ownership is part of the query: other principals' conversations are indistinguishable from missing ones. */
      async getOwned(customerId: string, ownerPrincipalId: string, id: string) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
        const [row] = await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.customerId, customerId), eq(conversations.ownerPrincipalId, ownerPrincipalId), eq(conversations.id, id)));
        return row;
      },
      async listOwned(customerId: string, ownerPrincipalId: string, limit = 50) {
        return db
          .select()
          .from(conversations)
          .where(and(eq(conversations.customerId, customerId), eq(conversations.ownerPrincipalId, ownerPrincipalId)))
          .orderBy(desc(conversations.updatedAt))
          .limit(limit);
      },
      async touch(id: string, title?: string): Promise<void> {
        await db.update(conversations).set({ updatedAt: new Date(), ...(title ? { title } : {}) }).where(eq(conversations.id, id));
      },
    },

    messages: {
      async add(input: {
        conversationId: string;
        customerId: string;
        role: "user" | "assistant";
        content: string;
        status?: string;
        citations?: StoredCitation[];
        model?: { provider: string; name: string };
        toolCalls?: StoredToolCall[];
        proposalIds?: string[];
        runId?: string;
      }) {
        const [row] = await db
          .insert(messages)
          .values({
            ...input,
            status: input.status ?? null,
            citations: input.citations ?? [],
            toolCalls: input.toolCalls ?? [],
            proposalIds: input.proposalIds ?? [],
            model: input.model ?? null,
            runId: input.runId ?? null,
          })
          .returning();
        return row!;
      },
      async list(customerId: string, conversationId: string) {
        return db
          .select()
          .from(messages)
          .where(and(eq(messages.customerId, customerId), eq(messages.conversationId, conversationId)))
          .orderBy(asc(messages.createdAt), asc(messages.id));
      },
    },

    runs: {
      async start(input: {
        customerId: string;
        principalId: string;
        conversationId?: string;
        requestId: string;
        agentId: string;
        agentVersion: string;
        policyVersion: string;
      }): Promise<string> {
        const [row] = await db
          .insert(agentRuns)
          .values({ ...input, conversationId: input.conversationId ?? null, status: "running" })
          .returning({ id: agentRuns.id });
        return row!.id;
      },
      async finish(
        id: string,
        result: {
          status: string;
          toolCalls: number;
          model?: { provider: string; name: string };
          usage?: { inputTokens?: number; outputTokens?: number };
          error?: string;
        },
      ): Promise<void> {
        await db
          .update(agentRuns)
          .set({
            status: result.status,
            toolCalls: result.toolCalls,
            model: result.model ?? null,
            usage: result.usage ?? null,
            error: result.error ?? null,
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, id));
      },
    },

    /** Sealed personal connection tokens (ADR 0015); sealing happens in the connectors package. */
    connections: {
      async get(customerId: string, principalId: string, provider: string) {
        const [row] = await db
          .select()
          .from(personalConnections)
          .where(and(eq(personalConnections.customerId, customerId), eq(personalConnections.principalId, principalId), eq(personalConnections.provider, provider)));
        return row;
      },
      async upsert(row: {
        customerId: string;
        principalId: string;
        provider: string;
        accountEmail: string | null;
        connectedBy: string | null;
        scopes: string[];
        accessTokenSealed: string;
        refreshTokenSealed: string | null;
        accessTokenExpiresAt: Date;
      }): Promise<void> {
        const { customerId: _c, principalId: _p, provider: _v, ...rest } = row;
        await db
          .insert(personalConnections)
          .values(row)
          .onConflictDoUpdate({
            target: [personalConnections.customerId, personalConnections.principalId, personalConnections.provider],
            // Keep an earlier refresh token when Google doesn't send a new one.
            set: { ...rest, refreshTokenSealed: row.refreshTokenSealed ?? undefined, updatedAt: new Date() },
          });
      },
      async delete(customerId: string, principalId: string, provider: string): Promise<boolean> {
        const r = await db
          .delete(personalConnections)
          .where(and(eq(personalConnections.customerId, customerId), eq(personalConnections.principalId, principalId), eq(personalConnections.provider, provider)))
          .returning({ id: personalConnections.id });
        return r.length > 0;
      },
    },

    oauthStates: {
      async create(row: { state: string; customerId: string; principalId: string; provider: string; browserNonceHash: string; codeVerifier: string; expiresAt: Date }) {
        await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
        await db.insert(oauthStates).values(row);
      },
      /** Single use: the row is deleted as it is read, so a replayed callback finds nothing. */
      async take(state: string, now = new Date()) {
        const [row] = await db.delete(oauthStates).where(eq(oauthStates.state, state)).returning();
        return row && row.expiresAt > now ? row : undefined;
      },
    },

    audit: {
      async write(e: AuditInput): Promise<void> {
        await db.insert(auditEvents).values({
          customerId: e.customerId,
          principalId: e.principalId ?? null,
          requestId: e.requestId ?? null,
          action: e.action,
          resourceType: e.resourceType ?? null,
          resourceId: e.resourceId ?? null,
          outcome: e.outcome,
          detail: e.detail ?? {},
        });
      },
      async list(customerId: string, limit = 100) {
        return db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.customerId, customerId))
          .orderBy(desc(auditEvents.createdAt))
          .limit(limit);
      },
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
