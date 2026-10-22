import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { ActionProposalView } from "@platform/contracts";
import type { CapabilityRegistry, RegisteredCapability } from "@platform/agents";
import { ConnectorError, type ConnectorRegistry } from "@platform/connectors";
import { schema, type ActionStateValue, type AuditInput, type Database, type PrincipalRecord } from "@platform/database";
import { canonicalHash, NotFoundOrForbiddenError, type TrustedContext } from "@platform/security";

const { actionProposals, approvals, executionAttempts, outboxEvents } = schema;
type ProposalRow = typeof actionProposals.$inferSelect;

export class ActionConflictError extends Error {
  readonly code = "conflict";
  constructor(
    readonly reason: "payload_mismatch" | "invalid_state" | "expired" | "policy_changed",
    message: string,
  ) {
    super(message);
    this.name = "ActionConflictError";
  }
}

export interface ActionServiceDeps {
  db: Database;
  capabilities: CapabilityRegistry;
  connectors: ConnectorRegistry;
  principals: { get(customerId: string, principalId: string): Promise<PrincipalRecord | undefined> };
  audit: { write(e: AuditInput): Promise<void> };
  /** Proposal lifetime before approval. */
  ttlMs?: number;
  now?: () => Date;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}

/** Upsert: re-opens a processed event of the same type/aggregate (dedupe key). */
async function enqueue(db: Pick<Database, "insert">, type: string, aggregateId: string, now: Date): Promise<void> {
  await db
    .insert(outboxEvents)
    .values({ type, aggregateId, availableAt: now })
    .onConflictDoUpdate({ target: [outboxEvents.type, outboxEvents.aggregateId], set: { processedAt: null, availableAt: now, lastError: null } });
}

export interface ProposeInput {
  capabilityId: string;
  input: Record<string, unknown>;
  conversationId?: string;
  runId?: string;
  dedupeKey?: string;
  ttlMs?: number;
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** Upper bound for a proposal's lifetime, whatever the caller asks for. */
const MAX_TTL_MS = 7 * 24 * 60 * 60_000;

export type ExecutionOutcome = "succeeded" | "failed" | "unknown" | "expired" | "skipped" | "reconciled";

/**
 * Proposals, approvals and execution (handoff §5).
 *
 *   pending_approval -> approved -> executing -> succeeded | failed | unknown
 *          |                                        unknown -> succeeded (reconciled)
 *   rejected / expired / cancelled
 *
 * Every transition is a conditional UPDATE inside a transaction. A model can
 * only cause `propose`; approval requires an authenticated user and the exact
 * payload hash; execution reloads everything and re-authorizes.
 */
export class ActionService {
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(private readonly d: ActionServiceDeps) {
    this.ttlMs = d.ttlMs ?? 30 * 60_000;
    this.now = d.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  static hashOf(p: Pick<ProposalRow, "customerId" | "principalId" | "capabilityId" | "capabilityVersion" | "connectorId" | "tool" | "payload" | "policyVersion" | "expiresAt">): string {
    return canonicalHash({
      customerId: p.customerId,
      principalId: p.principalId,
      operation: p.capabilityId,
      capabilityVersion: p.capabilityVersion,
      connectorId: p.connectorId,
      tool: p.tool,
      payload: p.payload,
      policyVersion: p.policyVersion,
      expiresAt: p.expiresAt.toISOString(),
    });
  }

  private authorized(principal: PrincipalRecord | undefined, customerId: string, cap: RegisteredCapability | undefined): boolean {
    if (!principal || principal.disabled || principal.customerId !== customerId || !cap) return false;
    const req = cap.definition.requiredGroups;
    return req.length === 0 || req.some((g) => principal.groups.includes(g));
  }

  static view(r: ProposalRow): ActionProposalView {
    return {
      id: r.id,
      state: r.state,
      capabilityId: r.capabilityId,
      connectorId: r.connectorId,
      operation: r.operation,
      destination: r.destination,
      risk: r.risk,
      payload: r.payload,
      payloadHash: r.payloadHash,
      conversationId: r.conversationId,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      receipt: r.receipt ?? null,
      lastError: r.lastError ?? null,
    };
  }

  private async owned(ctx: TrustedContext, id: string): Promise<ProposalRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundOrForbiddenError();
    const [row] = await this.d.db
      .select()
      .from(actionProposals)
      .where(and(eq(actionProposals.id, id), eq(actionProposals.customerId, ctx.customerId), eq(actionProposals.principalId, ctx.principalId)));
    if (!row) throw new NotFoundOrForbiddenError();
    return row;
  }

  // ---------------------------------------------------------------------------
  // User-facing operations (TrustedContext required)
  // ---------------------------------------------------------------------------

  /**
   * Called by the agent runtime (and workflows) for write capabilities. Never
   * executes anything.
   *
   * With `dedupeKey`, proposing the same logical write again (a retried,
   * redelivered or later workflow run) returns the existing proposal while it
   * can still be decided, and also after the user rejected or approved it. A
   * proposal that can no longer be approved (expired, or made under an older
   * policy version) is retired and replaced, so the change is raised again
   * instead of being lost.
   *
   * `ttlMs` overrides the default lifetime (bounded to 7 days), e.g. for
   * proposals made while nobody is at the screen.
   */
  async propose(ctx: TrustedContext, input: ProposeInput): Promise<ActionProposalView> {
    return (await this.proposeOnce(ctx, input)).proposal;
  }

  /** Like `propose`, and also says whether this call created the proposal (false: an existing one was returned). */
  async proposeOnce(ctx: TrustedContext, input: ProposeInput): Promise<{ proposal: ActionProposalView; created: boolean }> {
    const cap = this.d.capabilities.get(input.capabilityId);
    if (!cap?.write || cap.definition.kind !== "write") throw new NotFoundOrForbiddenError("unknown write capability");
    const principal = await this.d.principals.get(ctx.customerId, ctx.principalId);
    if (!this.authorized(principal, ctx.customerId, cap)) throw new NotFoundOrForbiddenError();
    const parsed = cap.definition.input.parse(input.input);
    const idempotencyKey = randomUUID();
    const payload = cap.write.toConnectorArgs(parsed, { idempotencyKey, principalDisplayName: principal!.displayName });
    const desc = cap.write.describe(parsed);
    const base = {
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      capabilityId: cap.definition.id,
      capabilityVersion: cap.definition.version,
      connectorId: cap.write.connectorId,
      tool: cap.write.tool,
      payload,
      policyVersion: ctx.policyVersion,
      expiresAt: new Date(this.now().getTime() + Math.min(Math.max(input.ttlMs ?? this.ttlMs, 60_000), MAX_TTL_MS)),
    };
    const values = {
      ...base,
      conversationId: input.conversationId ?? null,
      runId: input.runId ?? null,
      operation: desc.operation,
      destination: desc.destination,
      risk: desc.risk,
      payloadHash: ActionService.hashOf(base),
      idempotencyKey,
      dedupeKey: input.dedupeKey ?? null,
      state: "pending_approval" as const,
    };
    const dedupe = (key: string) =>
      this.d.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(actionProposals)
          .where(and(eq(actionProposals.customerId, ctx.customerId), eq(actionProposals.dedupeKey, key)))
          .for("update");
        if (existing) {
          if (existing.principalId !== ctx.principalId) throw new NotFoundOrForbiddenError();
          const stale =
            existing.state === "expired" ||
            (existing.state === "pending_approval" && (this.now() >= existing.expiresAt || existing.policyVersion !== ctx.policyVersion));
          if (!stale) return { row: existing, created: false };
          // Retire the old proposal (kept for history under a derived key) and raise the change again.
          await tx
            .update(actionProposals)
            .set({
              dedupeKey: `${key}#retired:${existing.id}`,
              ...(existing.state === "pending_approval" ? { state: "expired" as const, decidedAt: this.now() } : {}),
              updatedAt: this.now(),
            })
            .where(eq(actionProposals.id, existing.id));
        }
        const [inserted] = await tx.insert(actionProposals).values(values).returning();
        return { row: inserted!, created: true, replaced: existing?.id };
      });
    let result: { row: ProposalRow; created: boolean; replaced?: string };
    if (!input.dedupeKey) result = { row: (await this.d.db.insert(actionProposals).values(values).returning())[0]!, created: true };
    else {
      try {
        result = await dedupe(input.dedupeKey);
      } catch (err) {
        // A concurrent first proposal with the same key won the insert: return that one.
        if (!isUniqueViolation(err)) throw err;
        result = await dedupe(input.dedupeKey);
      }
    }
    if (!result.created) return { proposal: ActionService.view(result.row), created: false };
    const row = result.row;
    await this.d.audit.write({
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      action: "action.proposed",
      resourceType: "action",
      resourceId: row!.id,
      outcome: "ok",
      detail: { capabilityId: cap.definition.id, runId: input.runId ?? null, ...(result.replaced ? { replaces: result.replaced } : {}) },
    });
    return { proposal: ActionService.view(row!), created: true };
  }

  async get(ctx: TrustedContext, id: string): Promise<ActionProposalView> {
    return ActionService.view(await this.owned(ctx, id));
  }

  async list(ctx: TrustedContext, filter: { conversationId?: string; ids?: string[] } = {}): Promise<ActionProposalView[]> {
    const conds = [eq(actionProposals.customerId, ctx.customerId), eq(actionProposals.principalId, ctx.principalId)];
    if (filter.conversationId) conds.push(eq(actionProposals.conversationId, filter.conversationId));
    if (filter.ids) {
      const ids = filter.ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
      if (!ids.length) return [];
      conds.push(inArray(actionProposals.id, ids));
    }
    const rows = await this.d.db.select().from(actionProposals).where(and(...conds)).orderBy(desc(actionProposals.createdAt)).limit(100);
    return rows.map(ActionService.view);
  }

  /**
   * Approve exactly what was displayed: the caller must send the payload hash
   * it rendered. Approval and its outbox event commit together.
   */
  async approve(ctx: TrustedContext, id: string, payloadHash: string): Promise<ActionProposalView> {
    const row = await this.owned(ctx, id);
    const cap = this.d.capabilities.get(row.capabilityId);
    const principal = await this.d.principals.get(ctx.customerId, ctx.principalId);
    if (!this.authorized(principal, ctx.customerId, cap)) throw new NotFoundOrForbiddenError();
    if (row.state !== "pending_approval") throw new ActionConflictError("invalid_state", `action is ${row.state}`);
    if (this.now() >= row.expiresAt) {
      await this.transition(row.id, "pending_approval", "expired", { decidedAt: this.now() });
      throw new ActionConflictError("expired", "proposal expired; ask the assistant again");
    }
    if (row.policyVersion !== ctx.policyVersion) throw new ActionConflictError("policy_changed", "policy changed since the proposal; ask the assistant again");
    if (ActionService.hashOf(row) !== row.payloadHash) throw new ActionConflictError("payload_mismatch", "stored proposal failed integrity check");
    if (payloadHash !== row.payloadHash) throw new ActionConflictError("payload_mismatch", "the approved payload does not match the proposal");

    const updated = await this.d.db.transaction(async (tx) => {
      const [u] = await tx
        .update(actionProposals)
        .set({ state: "approved", approvedBy: ctx.principalId, decidedAt: this.now(), updatedAt: this.now() })
        .where(and(eq(actionProposals.id, row.id), eq(actionProposals.state, "pending_approval")))
        .returning();
      if (!u) throw new ActionConflictError("invalid_state", "action changed concurrently");
      await tx.insert(approvals).values({
        proposalId: row.id,
        customerId: ctx.customerId,
        approverPrincipalId: ctx.principalId,
        decision: "approved",
        payloadHash,
        policyVersion: ctx.policyVersion,
        requestId: ctx.requestId,
      });
      await enqueue(tx, "action.execute", row.id, this.now());
      return u;
    });
    await this.d.audit.write({
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      action: "action.approved",
      resourceType: "action",
      resourceId: row.id,
      outcome: "allowed",
      detail: { capabilityId: row.capabilityId },
    });
    return ActionService.view(updated);
  }

  async reject(ctx: TrustedContext, id: string): Promise<ActionProposalView> {
    const row = await this.owned(ctx, id);
    if (row.state !== "pending_approval") throw new ActionConflictError("invalid_state", `action is ${row.state}`);
    const u = await this.d.db.transaction(async (tx) => {
      const [u] = await tx
        .update(actionProposals)
        .set({ state: "rejected", decidedAt: this.now(), updatedAt: this.now() })
        .where(and(eq(actionProposals.id, row.id), eq(actionProposals.state, "pending_approval")))
        .returning();
      if (!u) throw new ActionConflictError("invalid_state", "action changed concurrently");
      await tx.insert(approvals).values({
        proposalId: row.id,
        customerId: ctx.customerId,
        approverPrincipalId: ctx.principalId,
        decision: "rejected",
        payloadHash: row.payloadHash,
        policyVersion: ctx.policyVersion,
        requestId: ctx.requestId,
      });
      return u;
    });
    await this.d.audit.write({ customerId: ctx.customerId, principalId: ctx.principalId, requestId: ctx.requestId, action: "action.rejected", resourceType: "action", resourceId: row.id, outcome: "ok" });
    return ActionService.view(u);
  }

  // ---------------------------------------------------------------------------
  // Execution (worker only; no request context, everything is reloaded)
  // ---------------------------------------------------------------------------

  private async transition(id: string, from: ActionStateValue | ActionStateValue[], to: ActionStateValue, set: Partial<ProposalRow> = {}): Promise<ProposalRow | undefined> {
    const fromList = Array.isArray(from) ? from : [from];
    const [u] = await this.d.db
      .update(actionProposals)
      .set({ ...set, state: to, updatedAt: this.now() })
      .where(and(eq(actionProposals.id, id), inArray(actionProposals.state, fromList)))
      .returning();
    return u;
  }

  async executeApproved(actionId: string): Promise<ExecutionOutcome> {
    // Atomic claim: concurrent workers or duplicate deliveries cannot both pass.
    const [claimed] = await this.d.db
      .update(actionProposals)
      .set({ state: "executing", attempts: sql`${actionProposals.attempts} + 1`, updatedAt: this.now() })
      .where(and(eq(actionProposals.id, actionId), eq(actionProposals.state, "approved")))
      .returning();
    if (!claimed) return "skipped";
    const attempt = claimed.attempts;
    const [att] = await this.d.db.insert(executionAttempts).values({ proposalId: claimed.id, attempt }).returning();
    const finish = async (outcome: ExecutionOutcome, to: ActionStateValue, extra: { receipt?: Record<string, unknown>; error?: string; errorKind?: string } = {}) => {
      await this.d.db.transaction(async (tx) => {
        await tx
          .update(actionProposals)
          .set({ state: to, receipt: extra.receipt ?? null, lastError: extra.error ?? null, updatedAt: this.now() })
          .where(and(eq(actionProposals.id, claimed.id), eq(actionProposals.state, "executing")));
        await tx
          .update(executionAttempts)
          .set({ outcome: outcome === "expired" ? "skipped" : (outcome as "succeeded" | "failed" | "unknown"), errorKind: extra.errorKind ?? null, receipt: extra.receipt ?? null, finishedAt: this.now() })
          .where(eq(executionAttempts.id, att!.id));
        if (to === "unknown") await enqueue(tx, "action.reconcile", claimed.id, this.now());
      });
      await this.d.audit.write({
        customerId: claimed.customerId,
        principalId: claimed.principalId,
        action: `action.${outcome}`,
        resourceType: "action",
        resourceId: claimed.id,
        outcome: outcome === "succeeded" ? "ok" : outcome === "failed" ? "error" : "denied",
        detail: { capabilityId: claimed.capabilityId, attempt, errorKind: extra.errorKind ?? null },
      });
      return outcome;
    };

    // Re-validate everything from storage.
    if (ActionService.hashOf(claimed) !== claimed.payloadHash) return finish("failed", "failed", { error: "integrity check failed", errorKind: "integrity" });
    if (this.now() >= new Date(claimed.expiresAt.getTime() + 5 * 60_000)) return finish("expired", "expired", { error: "approved action not executed in time", errorKind: "expired" });
    const cap = this.d.capabilities.get(claimed.capabilityId);
    if (!cap?.write || cap.definition.version !== claimed.capabilityVersion || cap.write.tool !== claimed.tool) {
      return finish("failed", "failed", { error: "capability changed since approval; re-propose", errorKind: "capability_changed" });
    }
    const principal = await this.d.principals.get(claimed.customerId, claimed.principalId);
    if (!this.authorized(principal, claimed.customerId, cap)) return finish("failed", "failed", { error: "principal no longer authorized", errorKind: "denied" });
    const connector = this.d.connectors.get(claimed.connectorId);
    if (!connector) return finish("failed", "failed", { error: "connector unavailable", errorKind: "unavailable" });

    try {
      const res = await connector.call(claimed.tool, claimed.payload, { classification: "write" });
      return finish("succeeded", "succeeded", { receipt: cap.write.receipt(res.data) });
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === "ambiguous_outcome") {
        return finish("unknown", "unknown", { error: "outcome unknown; reconciling before any retry", errorKind: err.kind });
      }
      const kind = err instanceof ConnectorError ? err.kind : "error";
      return finish("failed", "failed", { error: (err as Error).message.slice(0, 300), errorKind: kind });
    }
  }

  /** Resolves `unknown` via a provider receipt lookup. Never re-executes. */
  async reconcile(actionId: string): Promise<ExecutionOutcome> {
    const [row] = await this.d.db.select().from(actionProposals).where(eq(actionProposals.id, actionId));
    if (!row || row.state !== "unknown") return "skipped";
    const cap = this.d.capabilities.get(row.capabilityId);
    const connector = this.d.connectors.get(row.connectorId);
    if (!cap?.write?.reconcile || !connector) {
      await this.transition(row.id, "unknown", "unknown", { lastError: "cannot reconcile automatically: operator review required" });
      return "unknown";
    }
    try {
      const receipt = await cap.write.reconcile(async (tool, args) => (await connector.call(tool, args, { classification: "read" })).data, row.payload);
      if (receipt) {
        await this.transition(row.id, "unknown", "succeeded", { receipt, lastError: null });
        await this.d.db.insert(executionAttempts).values({ proposalId: row.id, attempt: row.attempts + 1000, outcome: "reconciled", receipt, finishedAt: this.now() }).onConflictDoNothing();
        await this.d.audit.write({ customerId: row.customerId, principalId: row.principalId, action: "action.reconciled", resourceType: "action", resourceId: row.id, outcome: "ok" });
        return "reconciled";
      }
      await this.transition(row.id, "unknown", "unknown", { lastError: "write not found at provider: operator review required before any retry" });
      return "unknown";
    } catch (err) {
      await this.transition(row.id, "unknown", "unknown", { lastError: `reconciliation failed: ${(err as Error).message.slice(0, 200)}` });
      return "unknown";
    }
  }

  /** Expires stale proposals so they can never be approved later. */
  async expireStale(): Promise<number> {
    const rows = await this.d.db
      .update(actionProposals)
      .set({ state: "expired", decidedAt: this.now(), updatedAt: this.now() })
      .where(and(eq(actionProposals.state, "pending_approval"), lte(actionProposals.expiresAt, this.now())))
      .returning({ id: actionProposals.id });
    return rows.length;
  }

  /** Executions interrupted by a crash are treated as uncertain and reconciled. */
  async recoverInterrupted(olderThanMs = 5 * 60_000): Promise<number> {
    const rows = await this.d.db
      .update(actionProposals)
      .set({ state: "unknown", lastError: "execution interrupted; reconciling", updatedAt: this.now() })
      .where(and(eq(actionProposals.state, "executing"), lt(actionProposals.updatedAt, new Date(this.now().getTime() - olderThanMs))))
      .returning({ id: actionProposals.id });
    for (const r of rows) await enqueue(this.d.db, "action.reconcile", r.id, this.now());
    return rows.length;
  }

  /**
   * Consumes outbox events with a lease (SKIP LOCKED), so several workers and
   * redelivered events are safe: execution itself is guarded by the atomic claim.
   */
  async processOutbox(limit = 10, leaseMs = 60_000): Promise<number> {
    const leased = await this.d.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(and(isNull(outboxEvents.processedAt), lte(outboxEvents.availableAt, this.now())))
        .orderBy(asc(outboxEvents.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      for (const r of rows) {
        await tx
          .update(outboxEvents)
          .set({ attempts: r.attempts + 1, availableAt: new Date(this.now().getTime() + leaseMs) })
          .where(eq(outboxEvents.id, r.id));
      }
      return rows;
    });
    let done = 0;
    for (const ev of leased) {
      try {
        if (ev.type === "action.execute") await this.executeApproved(ev.aggregateId);
        else if (ev.type === "action.reconcile") await this.reconcile(ev.aggregateId);
        await this.d.db.update(outboxEvents).set({ processedAt: this.now(), lastError: null }).where(eq(outboxEvents.id, ev.id));
        done++;
      } catch (err) {
        this.d.log?.("outbox event failed", { id: ev.id, type: ev.type, error: (err as Error).message });
        await this.d.db.update(outboxEvents).set({ lastError: (err as Error).message.slice(0, 300) }).where(eq(outboxEvents.id, ev.id));
      }
    }
    return done;
  }
}
export * from "./integrations.js";
