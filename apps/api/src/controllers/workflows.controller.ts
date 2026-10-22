import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { CreateWorkflowRequestSchema, type WorkflowKindView, type WorkflowRunView, type WorkflowView } from "@platform/contracts";
import type { TrustedContext } from "@platform/security";
import { Ctx } from "../auth/decorators.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

/** Scheduled workflows (ADR 0011). Only the owner can see or change a workflow; runs execute in the worker. */
@Controller()
export class WorkflowsController {
  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  @Get("workflow-kinds")
  kinds(): WorkflowKindView[] {
    return this.deps.workflows.listKinds();
  }

  @Get("workflows")
  list(@Ctx() ctx: TrustedContext): Promise<WorkflowView[]> {
    return this.deps.workflows.list(ctx);
  }

  @Post("workflows")
  create(@Ctx() ctx: TrustedContext, @Body() body: unknown): Promise<WorkflowView> {
    return this.deps.workflows.create(ctx, CreateWorkflowRequestSchema.parse(body));
  }

  @Get("workflows/:id/runs")
  runs(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<WorkflowRunView[]> {
    return this.deps.workflows.runs(ctx, id);
  }

  @Post("workflows/:id/pause")
  @HttpCode(200)
  pause(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<WorkflowView> {
    return this.deps.workflows.setEnabled(ctx, id, false);
  }

  @Post("workflows/:id/resume")
  @HttpCode(200)
  resume(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<WorkflowView> {
    return this.deps.workflows.setEnabled(ctx, id, true);
  }

  /** Schedules a run now; the worker executes it within about a minute. */
  @Post("workflows/:id/run-now")
  @HttpCode(200)
  runNow(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<WorkflowView> {
    return this.deps.workflows.runNow(ctx, id);
  }
}
