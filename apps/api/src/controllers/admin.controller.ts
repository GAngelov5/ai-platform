import { Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { NotFoundOrForbiddenError, type TrustedContext } from "@platform/security";
import { AdminOnly, Ctx } from "../auth/decorators.js";
import { configuredSources, type PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const withTimeout = <T>(p: Promise<T>, fallback: T, ms = 3000) => Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/**
 * Admin console (ADR 0012). Every route needs the "admin" role, and returns
 * operational metadata only: counts, titles, states, errors, timestamps. Never
 * document text, excerpts, message bodies or proposal payload values; an admin
 * gets no more document access than their own groups give them.
 */
@Controller("admin")
@AdminOnly()
export class AdminController {
  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  private async health() {
    const { knowledge, model, connectors } = this.deps;
    const [k, m, conns] = await Promise.all([
      withTimeout(knowledge.health(), { ok: false, detail: "health timeout" }),
      model.health ? withTimeout(model.health(), { ok: false, detail: "health timeout" }) : Promise.resolve({ ok: true, detail: model.descriptor.provider }),
      Promise.all(connectors.list().map(async (c) => ({ id: c.id, ...(await withTimeout(c.health(), { ok: false, detail: "health timeout" })) }))),
    ]);
    return { knowledge: k, model: m, connectors: conns };
  }

  @Get("overview")
  async overview(@Ctx() ctx: TrustedContext) {
    const { admin, config } = this.deps;
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [health, sources, actions, wfs, runs, staleRuns, failures] = await Promise.all([
      this.health(),
      this.sources(ctx),
      admin.actionCounts(ctx.customerId),
      admin.workflows(ctx.customerId),
      admin.agentRunStats(ctx.customerId, since),
      admin.staleWorkflowRuns(ctx.customerId, new Date(Date.now() - 15 * 60_000)),
      admin.audit(ctx.customerId, { outcome: "denied", before: undefined, limit: 500 }),
    ]);
    const deniedLast24h = failures.filter((a) => a.createdAt >= since).length;
    const byStatus: Record<string, number> = {};
    for (const r of runs.rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
    return {
      environment: config.env,
      knowledgeProvider: config.knowledge.provider,
      evidenceScoring: config.evidenceScoring.mode,
      health,
      sources: {
        configured: sources.length,
        documents: sources.reduce((s, x) => s + x.documents, 0),
        indexed: sources.reduce((s, x) => s + x.indexed, 0),
        quarantined: sources.reduce((s, x) => s + x.quarantined, 0),
        withErrors: sources.filter((x) => x.lastRun?.error).map((x) => x.id),
        syncRequested: sources.filter((x) => x.syncRequested).map((x) => x.id),
      },
      actions: {
        waiting: actions.pending_approval ?? 0,
        unknown: actions.unknown ?? 0,
        failed: actions.failed ?? 0,
        executing: (actions.approved ?? 0) + (actions.executing ?? 0),
      },
      workflows: {
        total: wfs.length,
        enabled: wfs.filter((w) => w.enabled).length,
        failingLast24h: wfs.filter((w) => w.failedLast24h > 0).length,
        staleRuns,
      },
      agentRunsLast24h: { byStatus, running: runs.running },
      deniedEventsLast24h: deniedLast24h,
    };
  }

  @Get("sources")
  async sources(@Ctx() ctx: TrustedContext) {
    const { admin, config } = this.deps;
    const [counts, states, quarantine] = await Promise.all([admin.sourceCounts(ctx.customerId), admin.syncStates(ctx.customerId), admin.quarantineCounts(ctx.customerId)]);
    return configuredSources(config).map((s) => {
      const c = counts.get(s.id);
      const st = states.get(s.id);
      const lastFinished = st?.lastRun?.finishedAt ? new Date(st.lastRun.finishedAt) : undefined;
      return {
        id: s.id,
        title: s.title,
        kind: s.kind,
        /** Native group → platform group. Platform groups only; no credentials or paths. */
        aclMap: s.aclPassThrough ? "pass-through (synthetic fixtures)" : s.aclMap,
        documents: c?.documents ?? 0,
        indexed: c?.indexed ?? 0,
        unsearchable: c?.unsearchable ?? 0,
        tombstoned: c?.tombstoned ?? 0,
        quarantined: quarantine.get(s.id) ?? 0,
        lastRun: st?.lastRun ?? null,
        syncRequested: !!st?.syncRequestedAt && (!lastFinished || lastFinished < st.syncRequestedAt),
        syncRequestedAt: iso(st?.syncRequestedAt),
        syncRequestedBy: st?.syncRequestedBy ?? null,
      };
    });
  }

  @Get("sources/:id/quarantine")
  async quarantine(@Ctx() ctx: TrustedContext, @Param("id") id: string) {
    if (!configuredSources(this.deps.config).some((s) => s.id === id)) throw new NotFoundOrForbiddenError();
    const rows = await this.deps.admin.quarantine(ctx.customerId, id);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /** Asks the worker to ingest (and sync) this source within about a minute. */
  @Post("sources/:id/sync")
  @HttpCode(202)
  async requestSync(@Ctx() ctx: TrustedContext, @Param("id") id: string) {
    if (!configuredSources(this.deps.config).some((s) => s.id === id)) throw new NotFoundOrForbiddenError();
    const at = new Date();
    await this.deps.admin.requestSync(ctx.customerId, id, ctx.principalId, at);
    await this.deps.repos.audit.write({ customerId: ctx.customerId, principalId: ctx.principalId, requestId: ctx.requestId, action: "admin.source.sync_requested", resourceType: "source", resourceId: id, outcome: "ok" });
    return { sourceId: id, requestedAt: at.toISOString() };
  }

  @Get("integrations")
  async integrations() {
    const { connectors, capabilities } = this.deps;
    const caps = capabilities.list().map((c) => c.definition);
    return Promise.all(
      connectors.list().map(async (c) => ({
        id: c.id,
        kind: c.kind,
        health: await withTimeout(c.health(), { ok: false, detail: "health timeout" }),
        tools: await withTimeout(c.tools(), []),
        capabilities: caps
          .filter((d) => d.connectorId === c.id)
          .map((d) => ({ id: d.id, version: d.version, kind: d.kind, requiredGroups: [...d.requiredGroups], description: d.description })),
      })),
    );
  }

  @Get("agents")
  agents() {
    return this.deps.agents.list().map((a) => ({
      id: a.id,
      version: a.version,
      name: a.name,
      description: a.description,
      capabilities: [...a.capabilities],
      sourceIds: [...a.knowledgeScopes.sourceIds],
      limits: a.limits,
    }));
  }

  @Get("actions")
  async actions(@Ctx() ctx: TrustedContext, @Query("state") state?: string) {
    const rows = await this.deps.admin.actions(ctx.customerId, { state: state || undefined });
    return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt), decidedAt: iso(r.decidedAt), expiresAt: iso(r.expiresAt), updatedAt: iso(r.updatedAt) }));
  }

  /** Re-checks an action whose outcome is unknown, by its idempotency key. Never re-executes blindly. */
  @Post("actions/:id/reconcile")
  @HttpCode(200)
  async reconcile(@Ctx() ctx: TrustedContext, @Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundOrForbiddenError();
    const [row] = await this.deps.admin.actions(ctx.customerId, { limit: 500 }).then((all) => all.filter((a) => a.id === id));
    if (!row) throw new NotFoundOrForbiddenError();
    const outcome = row.state === "unknown" ? await this.deps.actions.reconcile(id) : "skipped";
    await this.deps.repos.audit.write({ customerId: ctx.customerId, principalId: ctx.principalId, requestId: ctx.requestId, action: "admin.action.reconcile", resourceType: "action", resourceId: id, outcome: "ok", detail: { outcome } });
    return { id, outcome };
  }

  @Get("workflows")
  async workflows(@Ctx() ctx: TrustedContext) {
    const rows = await this.deps.admin.workflows(ctx.customerId);
    return rows.map((w) => ({
      ...w,
      nextRunAt: iso(w.nextRunAt),
      createdAt: iso(w.createdAt),
      lastRun: w.lastRun ? { ...w.lastRun, scheduledFor: iso(w.lastRun.scheduledFor), finishedAt: iso(w.lastRun.finishedAt) } : null,
    }));
  }

  @Get("audit")
  async audit(
    @Ctx() ctx: TrustedContext,
    @Query("action") action?: string,
    @Query("principal") principal?: string,
    @Query("outcome") outcome?: string,
    @Query("before") before?: string,
  ) {
    const b = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : undefined;
    const ok = outcome && ["ok", "allowed", "denied", "error"].includes(outcome) ? outcome : undefined;
    const rows = await this.deps.admin.audit(ctx.customerId, { action: action?.slice(0, 64), principalId: principal?.slice(0, 64), outcome: ok, before: b, limit: 100 });
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }
}
