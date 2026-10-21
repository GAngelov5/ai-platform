import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { ApproveActionRequestSchema, type ActionProposalView } from "@platform/contracts";
import { NotFoundOrForbiddenError, type TrustedContext } from "@platform/security";
import { Ctx } from "../auth/decorators.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

/** Proposed external writes. Only the proposing principal can see, approve or reject them. */
@Controller()
export class ActionsController {
  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  @Get("actions")
  list(@Ctx() ctx: TrustedContext, @Query("conversationId") conversationId?: string, @Query("ids") ids?: string): Promise<ActionProposalView[]> {
    return this.deps.actions.list(ctx, { conversationId: conversationId || undefined, ids: ids ? ids.split(",").slice(0, 50) : undefined });
  }

  @Get("actions/:id")
  get(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<ActionProposalView> {
    return this.deps.actions.get(ctx, id);
  }

  /** Requires the exact payload hash the user was shown. Execution happens asynchronously in the worker. */
  @Post("actions/:id/approve")
  @HttpCode(200)
  approve(@Ctx() ctx: TrustedContext, @Param("id") id: string, @Body() body: unknown): Promise<ActionProposalView> {
    const { payloadHash } = ApproveActionRequestSchema.parse(body);
    return this.deps.actions.approve(ctx, id, payloadHash);
  }

  @Post("actions/:id/reject")
  @HttpCode(200)
  reject(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<ActionProposalView> {
    return this.deps.actions.reject(ctx, id);
  }

  /** Live-read citations resolve only for the principal they were issued to. */
  @Get("live-evidence/:id")
  async liveEvidence(@Ctx() ctx: TrustedContext, @Param("id") id: string) {
    if (!/^lv_[A-Za-z0-9_-]{8,64}$/.test(id)) throw new NotFoundOrForbiddenError();
    const r = await this.deps.repos.liveEvidence.get(ctx.customerId, id);
    if (!r || r.principalId !== ctx.principalId) throw new NotFoundOrForbiddenError();
    return {
      evidenceId: r.evidenceId,
      connectorId: r.connectorId,
      capabilityId: r.capabilityId,
      resourceId: r.resourceId,
      title: r.title,
      excerpt: r.excerpt,
      readAt: r.readAt.toISOString(),
    };
  }

  @Get("capabilities")
  async capabilities(@Ctx() ctx: TrustedContext) {
    const principal = await this.deps.repos.principals.get(ctx.customerId, ctx.principalId);
    const agent = this.deps.agents.get("project-assistant");
    if (!principal || !agent) return [];
    const allowed = await this.deps.runtime.allowedCapabilities(agent, principal.groups);
    return allowed.map((c) => ({ id: c.definition.id, version: c.definition.version, kind: c.definition.kind, description: c.definition.description, connectorId: c.definition.connectorId ?? null }));
  }
}
