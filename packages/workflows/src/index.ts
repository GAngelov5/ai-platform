import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkflowKindView, WorkflowRunView, WorkflowView } from "@platform/contracts";
import type { CapabilityRegistry, LiveReadResult } from "@platform/agents";
import type { ActionService } from "@platform/actions";
import { schema, type AuditInput, type Database, type PrincipalRecord } from "@platform/database";
import { createTrustedContext, NotFoundOrForbiddenError, type TrustedContext } from "@platform/security";

const { workflows, workflowRuns } = schema;
type WorkflowRow = typeof workflows.$inferSelect;
type RunRow = typeof workflowRuns.$inferSelect;

// ---------------------------------------------------------------------------
// Workflow kinds
// ---------------------------------------------------------------------------

/** What a running workflow may do: the owner's capabilities, re-authorized on every call. */
export interface WorkflowRunContext {
  workflowId: string;
  runId: string;
  config: Record<string, unknown>;
  /** Result of the last successful run, for change detection. */
  previous: Record<string, unknown> | undefined;
  read(capabilityId: string, input: Record<string, unknown>): Promise<LiveReadResult[]>;
  /**
   * Proposes a write the owner must approve. Never executes. Idempotent per
   * dedupeKey: `created` is false when an approvable, approved or rejected
   * proposal already exists; an expired one is replaced (ActionService).
   */
  propose(capabilityId: string, input: Record<string, unknown>, dedupeKey: string): Promise<{ id: string; state: string; created: boolean }>;
  /** When this run was scheduled for (stable across retries). */
  scheduledFor: Date;
  signal: AbortSignal;
}

export interface WorkflowKind {
  kind: string;
  version: string;
  title: string;
  description: string;
  config: z.ZodType<Record<string, unknown>>;
  /** Capabilities the owner must hold when creating the workflow and on every run. */
  capabilities: readonly string[];
  /** Lifetime of this kind's proposals; scheduled runs happen while nobody is watching. Default 72 h. */
  proposalTtlMs?: number;
  /** Human-readable title for one configured workflow. */
  label(config: Record<string, unknown>): string;
  run(ctx: WorkflowRunContext): Promise<Record<string, unknown>>;
}

/** `since`: when this workflow first saw the task in its current status (stable across comments and edits). */
type TaskSnapshot = Record<string, { status: string; since: string; updatedAt: string; title: string }>;

/**
 * Checks a tracker project on a schedule. For each task in a watched status
 * (by default Blocked or At risk) it proposes ONE comment asking for an update;
 * the owner approves it like any other write.
 *
 * The dedupe key is task + status + when the workflow first saw that status,
 * so retries, later runs and the comment itself (which changes the task's
 * update time) never produce a second proposal. If the proposal expired
 * unanswered, the next run raises it again; a rejected one is not repeated.
 */
export const trackerStatusCheck: WorkflowKind = {
  kind: "tracker-status-check",
  version: "1.0.0",
  title: "Tracker status check",
  description: "Checks a tracker project on a schedule and proposes a comment (for your approval) when a task becomes blocked or at risk.",
  config: z.strictObject({
    project: z.string().trim().regex(/^[A-Za-z]{2,32}$/),
    watchStatuses: z.array(z.enum(["To do", "In progress", "Blocked", "At risk", "Done"])).min(1).max(5).default(["Blocked", "At risk"]),
  }),
  capabilities: ["tracker.tasks.list", "tracker.task.comment"],
  label: (c) => `Tracker status check · ${String(c.project).toUpperCase()}`,
  async run(ctx) {
    const config = trackerStatusCheck.config.parse(ctx.config) as { project: string; watchStatuses: string[] };
    const tasks = await ctx.read("tracker.tasks.list", { project: config.project });
    const before = (ctx.previous?.snapshot ?? {}) as TaskSnapshot;
    const snapshot: TaskSnapshot = {};
    const changes: { taskKey: string; from: string | null; to: string }[] = [];
    const proposals: { taskKey: string; proposalId: string }[] = [];
    for (const t of tasks) {
      const d = t.data as { status?: string; updatedAt?: string; title?: string };
      const status = String(d.status ?? "unknown");
      const prev = before[t.resourceId];
      const since = prev?.status === status ? prev.since : ctx.scheduledFor.toISOString();
      snapshot[t.resourceId] = { status, since, updatedAt: String(d.updatedAt ?? ""), title: String(d.title ?? t.title) };
      if (prev?.status !== status) changes.push({ taskKey: t.resourceId, from: prev?.status ?? null, to: status });
    }
    for (const [taskKey, now] of Object.entries(snapshot)) {
      if (!config.watchStatuses.includes(now.status)) continue;
      const was = changes.find((c) => c.taskKey === taskKey)?.from ?? null;
      const text = `Automated status check: ${taskKey} (${now.title}) is now "${now.status}"${was ? ` (was "${was}")` : ""}. Please add an update on the cause and the next step.`;
      // Every run asks; the dedupe key makes that a no-op unless the earlier proposal expired unanswered.
      const p = await ctx.propose("tracker.task.comment", { taskKey, text }, `wf:${ctx.workflowId}:${taskKey}:${now.status}:${now.since}`);
      if (p.created) proposals.push({ taskKey, proposalId: p.id });
    }
    return { project: config.project.toUpperCase(), checked: tasks.length, changes, proposals, snapshot };
  },
};

export class WorkflowKindRegistry {
  private readonly kinds = new Map<string, WorkflowKind>();
  constructor(kinds: readonly WorkflowKind[] = [trackerStatusCheck]) {
    for (const k of kinds) this.kinds.set(k.kind, k);
  }
  get(kind: string) {
    return this.kinds.get(kind);
  }
  list() {
    return [...this.kinds.values()];
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface WorkflowServiceDeps {
  db: Database;
  capabilities: CapabilityRegistry;
  actions: Pick<ActionService, "proposeOnce">;
  principals: { get(customerId: string, principalId: string): Promise<PrincipalRecord | undefined> };
  audit: { write(e: AuditInput): Promise<void> };
  /** Must match the API's policy version, so proposals stay approvable. */
  policyVersion: string;
  kinds?: WorkflowKindRegistry;
  now?: () => Date;
  /** A run still "running" this long after its heartbeat is taken over (crash recovery). */
  staleMs?: number;
  runTimeoutMs?: number;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}

export class WorkflowForbiddenError extends Error {
  readonly code = "forbidden";
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Scheduled runs often happen overnight: their proposals wait three days for a decision. */
const DEFAULT_PROPOSAL_TTL_MS = 72 * 60 * 60_000;

/**
 * Durable scheduled workflows (ADR 0011).
 *
 *   dispatch:  due workflow --(one transaction, SKIP LOCKED)--> run row per slot
 *              (unique workflow+slot: duplicate dispatch is a no-op)
 *   execute:   claim pending (or stale running) run -> kind.run() -> succeeded|failed
 *   writes:    only proposals, deduplicated; the owner approves each one
 *
 * All state is in PostgreSQL. The queue only says "check now"; losing,
 * repeating or delaying that signal changes nothing but timing.
 */
export class WorkflowService {
  readonly kinds: WorkflowKindRegistry;
  private readonly now: () => Date;

  constructor(private readonly d: WorkflowServiceDeps) {
    this.kinds = d.kinds ?? new WorkflowKindRegistry();
    this.now = d.now ?? (() => new Date());
  }

  // --- User-facing -------------------------------------------------------------

  listKinds(): WorkflowKindView[] {
    return this.kinds.list().map((k) => ({ kind: k.kind, version: k.version, title: k.title, description: k.description }));
  }

  private async principal(customerId: string, principalId: string): Promise<PrincipalRecord> {
    const p = await this.d.principals.get(customerId, principalId);
    if (!p || p.disabled || p.customerId !== customerId) throw new WorkflowForbiddenError("principal unavailable");
    return p;
  }

  private assertCapabilities(kind: WorkflowKind, principal: PrincipalRecord) {
    for (const id of kind.capabilities) {
      const cap = this.d.capabilities.get(id);
      const req = cap?.definition.requiredGroups ?? [];
      if (!cap || (req.length > 0 && !req.some((g) => principal.groups.includes(g)))) throw new WorkflowForbiddenError(`not allowed: ${id}`);
    }
  }

  async create(ctx: TrustedContext, input: { kind: string; config: Record<string, unknown>; intervalMinutes: number }): Promise<WorkflowView> {
    const kind = this.kinds.get(input.kind);
    if (!kind) throw new NotFoundOrForbiddenError("unknown workflow kind");
    const config = kind.config.parse(input.config);
    try {
      this.assertCapabilities(kind, await this.principal(ctx.customerId, ctx.principalId));
    } catch {
      throw new NotFoundOrForbiddenError();
    }
    const [row] = await this.d.db
      .insert(workflows)
      .values({
        customerId: ctx.customerId,
        principalId: ctx.principalId,
        kind: kind.kind,
        kindVersion: kind.version,
        config,
        intervalMinutes: input.intervalMinutes,
        nextRunAt: this.now(), // first check as soon as the worker next dispatches
      })
      .returning();
    await this.d.audit.write({
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      action: "workflow.created",
      resourceType: "workflow",
      resourceId: row!.id,
      outcome: "ok",
      detail: { kind: kind.kind, intervalMinutes: input.intervalMinutes },
    });
    return this.view(row!, null);
  }

  private async owned(ctx: TrustedContext, id: string): Promise<WorkflowRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundOrForbiddenError();
    const [row] = await this.d.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.customerId, ctx.customerId), eq(workflows.principalId, ctx.principalId)));
    if (!row) throw new NotFoundOrForbiddenError();
    return row;
  }

  async list(ctx: TrustedContext): Promise<WorkflowView[]> {
    const rows = await this.d.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.customerId, ctx.customerId), eq(workflows.principalId, ctx.principalId)))
      .orderBy(desc(workflows.createdAt));
    const out: WorkflowView[] = [];
    for (const r of rows) {
      const [last] = await this.d.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, r.id)).orderBy(desc(workflowRuns.scheduledFor)).limit(1);
      out.push(this.view(r, last ?? null));
    }
    return out;
  }

  async runs(ctx: TrustedContext, id: string, limit = 20): Promise<WorkflowRunView[]> {
    const w = await this.owned(ctx, id);
    const rows = await this.d.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, w.id)).orderBy(desc(workflowRuns.scheduledFor)).limit(Math.min(limit, 100));
    return rows.map((r) => WorkflowService.runView(r));
  }

  async setEnabled(ctx: TrustedContext, id: string, enabled: boolean): Promise<WorkflowView> {
    const w = await this.owned(ctx, id);
    const [row] = await this.d.db.update(workflows).set({ enabled, updatedAt: this.now() }).where(eq(workflows.id, w.id)).returning();
    return this.view(row!, null);
  }

  /** Schedules the next run for now; the worker picks it up on its next dispatch. */
  async runNow(ctx: TrustedContext, id: string): Promise<WorkflowView> {
    const w = await this.owned(ctx, id);
    const [row] = await this.d.db.update(workflows).set({ nextRunAt: this.now(), enabled: true, updatedAt: this.now() }).where(eq(workflows.id, w.id)).returning();
    return this.view(row!, null);
  }

  // --- Worker --------------------------------------------------------------------

  /**
   * Creates one run per due workflow and advances its schedule, in one
   * transaction. Missed slots are not back-filled: after downtime a workflow
   * runs once, then continues on its interval.
   */
  async dispatchDue(limit = 20): Promise<string[]> {
    const now = this.now();
    return this.d.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.enabled, true), lte(workflows.nextRunAt, now)))
        .orderBy(workflows.nextRunAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      const created: string[] = [];
      for (const w of due) {
        const [run] = await tx
          .insert(workflowRuns)
          .values({ workflowId: w.id, customerId: w.customerId, scheduledFor: w.nextRunAt })
          .onConflictDoNothing({ target: [workflowRuns.workflowId, workflowRuns.scheduledFor] })
          .returning({ id: workflowRuns.id });
        if (run) created.push(run.id);
        const step = w.intervalMinutes * 60_000;
        let next = w.nextRunAt.getTime() + step;
        if (next <= now.getTime()) next = now.getTime() + step;
        await tx.update(workflows).set({ nextRunAt: new Date(next), updatedAt: now }).where(eq(workflows.id, w.id));
      }
      return created;
    });
  }

  /** Pending runs, and runs whose worker died (stale heartbeat). */
  async runnable(limit = 20): Promise<string[]> {
    const staleBefore = new Date(this.now().getTime() - (this.d.staleMs ?? 10 * 60_000));
    const rows = await this.d.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(or(eq(workflowRuns.status, "pending"), and(eq(workflowRuns.status, "running"), or(isNull(workflowRuns.heartbeatAt), lt(workflowRuns.heartbeatAt, staleBefore)))))
      .orderBy(workflowRuns.createdAt)
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /** Conditional claim: exactly one worker gets a run (pending, or running with a stale heartbeat). */
  private async claim(runId: string): Promise<RunRow | undefined> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - (this.d.staleMs ?? 10 * 60_000));
    const [row] = await this.d.db
      .update(workflowRuns)
      .set({ status: "running", attempts: sql`${workflowRuns.attempts} + 1`, heartbeatAt: now, startedAt: now })
      .where(
        and(
          eq(workflowRuns.id, runId),
          or(eq(workflowRuns.status, "pending"), and(eq(workflowRuns.status, "running"), or(isNull(workflowRuns.heartbeatAt), lt(workflowRuns.heartbeatAt, staleBefore)))),
        ),
      )
      .returning();
    return row;
  }

  private async finish(runId: string, attempts: number, status: "succeeded" | "failed", result: Record<string, unknown> | null, error: string | null) {
    // Only the claimant of this attempt may finish it (a slow, taken-over worker cannot overwrite).
    await this.d.db
      .update(workflowRuns)
      .set({ status, result, error, finishedAt: this.now() })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "running"), eq(workflowRuns.attempts, attempts)));
  }

  /** Executes one run if it can be claimed. Returns its final status, or "skipped". */
  async execute(runId: string): Promise<"succeeded" | "failed" | "skipped"> {
    const run = await this.claim(runId);
    if (!run) return "skipped";
    const [w] = await this.d.db.select().from(workflows).where(eq(workflows.id, run.workflowId));
    const kind = w ? this.kinds.get(w.kind) : undefined;
    let principal: PrincipalRecord | undefined;
    try {
      if (!w || !kind) throw new Error("workflow or kind no longer exists");
      // Permissions are those of the owner NOW, not when the workflow was created.
      principal = await this.principal(w.customerId, w.principalId);
      this.assertCapabilities(kind, principal);
      const ctx = createTrustedContext({ customerId: w.customerId, principalId: w.principalId, policyVersion: this.d.policyVersion });
      const [prev] = await this.d.db
        .select({ result: workflowRuns.result })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.workflowId, w.id), eq(workflowRuns.status, "succeeded"), lt(workflowRuns.scheduledFor, run.scheduledFor)))
        .orderBy(desc(workflowRuns.scheduledFor))
        .limit(1);
      const signal = AbortSignal.timeout(this.d.runTimeoutMs ?? 120_000);
      const owner = principal;
      const result = await kind.run({
        workflowId: w.id,
        runId: run.id,
        config: w.config,
        previous: prev?.result ?? undefined,
        scheduledFor: run.scheduledFor,
        signal,
        read: async (capabilityId, input) => {
          if (!kind.capabilities.includes(capabilityId)) throw new WorkflowForbiddenError(`capability not declared: ${capabilityId}`);
          const cap = this.d.capabilities.get(capabilityId);
          if (!cap?.read || cap.definition.kind !== "read") throw new WorkflowForbiddenError(`not a read capability: ${capabilityId}`);
          const req = cap.definition.requiredGroups;
          if (req.length > 0 && !req.some((g) => owner.groups.includes(g))) throw new WorkflowForbiddenError(`not allowed: ${capabilityId}`);
          const parsed = cap.definition.input.parse(input);
          return cap.read(parsed, { signal: AbortSignal.any([signal, AbortSignal.timeout(cap.definition.timeoutMs)]), principal: { customerId: w.customerId, principalId: w.principalId } });
        },
        propose: async (capabilityId, input, dedupeKey) => {
          if (!kind.capabilities.includes(capabilityId)) throw new WorkflowForbiddenError(`capability not declared: ${capabilityId}`);
          const r = await this.d.actions.proposeOnce(ctx, { capabilityId, input, runId: run.id, dedupeKey, ttlMs: kind.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS });
          return { id: r.proposal.id, state: r.proposal.state, created: r.created };
        },
      });
      await this.finish(run.id, run.attempts, "succeeded", result, null);
      await this.d.audit.write({
        customerId: w.customerId,
        principalId: w.principalId,
        requestId: run.id,
        action: "workflow.run",
        resourceType: "workflow",
        resourceId: w.id,
        outcome: "ok",
        detail: { runId: run.id, attempt: run.attempts, proposals: Array.isArray(result.proposals) ? result.proposals.length : 0 },
      });
      return "succeeded";
    } catch (err) {
      const message = err instanceof WorkflowForbiddenError || err instanceof NotFoundOrForbiddenError ? `forbidden: ${(err as Error).message}` : (err as Error).message;
      await this.finish(run.id, run.attempts, "failed", null, message.slice(0, 500));
      if (w) {
        await this.d.audit.write({
          customerId: w.customerId,
          principalId: w.principalId,
          requestId: run.id,
          action: "workflow.run",
          resourceType: "workflow",
          resourceId: w.id,
          outcome: "error",
          detail: { runId: run.id, attempt: run.attempts, error: message.slice(0, 200) },
        });
      }
      this.d.log?.("workflow run failed", { runId: run.id, workflowId: run.workflowId, error: message });
      return "failed";
    }
  }

  /** One worker tick: dispatch due workflows, then execute every runnable run. */
  async tick(): Promise<{ dispatched: number; succeeded: number; failed: number }> {
    const dispatched = (await this.dispatchDue()).length;
    let succeeded = 0;
    let failed = 0;
    for (const id of await this.runnable()) {
      const r = await this.execute(id);
      if (r === "succeeded") succeeded++;
      if (r === "failed") failed++;
    }
    return { dispatched, succeeded, failed };
  }

  // --- Views ---------------------------------------------------------------------

  static runView(r: RunRow): WorkflowRunView {
    const { snapshot: _s, ...result } = r.result ?? {};
    return {
      id: r.id,
      scheduledFor: r.scheduledFor.toISOString(),
      status: r.status,
      attempts: r.attempts,
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      result: r.result ? result : null,
      error: r.error,
    };
  }

  private view(r: WorkflowRow, last: RunRow | null): WorkflowView {
    const kind = this.kinds.get(r.kind);
    return {
      id: r.id,
      kind: r.kind,
      title: kind ? kind.label(r.config) : r.kind,
      config: r.config,
      intervalMinutes: r.intervalMinutes,
      enabled: r.enabled,
      nextRunAt: r.nextRunAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      lastRun: last ? WorkflowService.runView(last) : null,
    };
  }
}

