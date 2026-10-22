import { Body, ConflictException, Controller, Get, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  CreateConversationRequestSchema,
  PostMessageRequestSchema,
  type AgentSummary,
  type AnswerStatus,
  type ConversationDetail,
  type ConversationSummary,
  type Message,
  type PostMessageResponse,
  type RunEvent,
} from "@platform/contracts";
import type { schema } from "@platform/database";
import { NotFoundOrForbiddenError, type TrustedContext } from "@platform/security";
import { Ctx } from "../auth/decorators.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

type ConversationRow = typeof schema.conversations.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

const WITHHELD = "This answer is withheld because at least one cited source is no longer accessible to you.";

const summary = (c: ConversationRow): ConversationSummary => ({
  id: c.id,
  agentId: c.agentId,
  title: c.title,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

const toMessage = (m: MessageRow): Message => ({
  id: m.id,
  role: m.role,
  content: m.content,
  status: (m.status ?? undefined) as AnswerStatus | undefined,
  citations: m.citations,
  model: m.model ?? undefined,
  toolCalls: m.toolCalls,
  proposalIds: m.proposalIds,
  createdAt: m.createdAt.toISOString(),
});

@Controller()
export class ConversationsController {
  /** Conversation id → its in-flight run (per API process). */
  private readonly inflight = new Map<string, AbortController>();

  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  @Get("agents")
  agents(): AgentSummary[] {
    return this.deps.agents.list().map((a) => ({ id: a.id, version: a.version, name: a.name, description: a.description }));
  }

  @Post("conversations")
  async create(@Ctx() ctx: TrustedContext, @Body() body: unknown): Promise<ConversationSummary> {
    const { agentId } = CreateConversationRequestSchema.parse(body);
    if (!this.deps.agents.get(agentId)) throw new NotFoundOrForbiddenError();
    const row = await this.deps.repos.conversations.create({
      customerId: ctx.customerId,
      ownerPrincipalId: ctx.principalId,
      agentId,
      title: "New conversation",
    });
    return summary(row);
  }

  @Get("conversations")
  async list(@Ctx() ctx: TrustedContext): Promise<ConversationSummary[]> {
    const rows = await this.deps.repos.conversations.listOwned(ctx.customerId, ctx.principalId);
    return rows.map(summary);
  }

  private async owned(ctx: TrustedContext, id: string): Promise<ConversationRow> {
    const c = await this.deps.repos.conversations.getOwned(ctx.customerId, ctx.principalId, id);
    if (!c) throw new NotFoundOrForbiddenError();
    return c;
  }

  /** Stored answers are re-checked against current permissions on every read. */
  private async visibleMessages(ctx: TrustedContext, rows: MessageRow[]): Promise<Message[]> {
    const docIds = (m: MessageRow) => m.citations.flatMap((c) => (c.kind === "live" ? [] : [c.documentId]));
    const readable = await this.deps.knowledge.filterReadableDocumentIds(ctx, rows.flatMap(docIds));
    return rows.map((m) => {
      const msg = toMessage(m);
      // Live citations are bound to this principal's own run; document citations are re-checked against current ACLs.
      if (m.role === "assistant" && docIds(m).some((id) => !readable.has(id))) {
        return { ...msg, content: WITHHELD, citations: [], status: "withheld" };
      }
      return msg;
    });
  }

  @Get("conversations/:id")
  async get(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<ConversationDetail> {
    const c = await this.owned(ctx, id);
    const rows = await this.deps.repos.messages.list(ctx.customerId, c.id);
    return { ...summary(c), messages: await this.visibleMessages(ctx, rows), runInProgress: this.inflight.has(c.id) };
  }

  /**
   * One agent turn, shared by the JSON and the streaming endpoints. The run is
   * owned by the server, not the HTTP request: a client that disconnects or
   * reloads doesn't lose it (the answer is stored, and `runInProgress` tells the
   * UI to wait). It ends with its own limits or an explicit cancel. One run at a
   * time per conversation. In-flight runs are per API process; the Compose
   * deployment runs one API instance.
   */
  private async turn(ctx: TrustedContext, id: string, body: unknown, opts: { onEvent?: (e: RunEvent) => void } = {}): Promise<PostMessageResponse> {
    const { content } = PostMessageRequestSchema.parse(body);
    const c = await this.owned(ctx, id);
    if (this.inflight.has(c.id)) throw new ConflictException("Your previous question in this conversation is still being answered.");
    const controller = new AbortController();
    this.inflight.set(c.id, controller);
    try {
      return await this.runTurn(ctx, c, content, controller.signal, opts.onEvent);
    } finally {
      this.inflight.delete(c.id);
    }
  }

  private async runTurn(
    ctx: TrustedContext,
    c: Awaited<ReturnType<ConversationsController["owned"]>>,
    content: string,
    signal: AbortSignal,
    onEvent?: (e: RunEvent) => void,
  ): Promise<PostMessageResponse> {
    const agent = this.deps.agents.get(c.agentId);
    if (!agent) throw new NotFoundOrForbiddenError();
    const { repos } = this.deps;
    const principal = await repos.principals.get(ctx.customerId, ctx.principalId);
    if (!principal || principal.disabled) throw new NotFoundOrForbiddenError();

    const prior = await this.visibleMessages(ctx, await repos.messages.list(ctx.customerId, c.id));
    const history = prior
      .filter((m) => m.role === "user" || m.status === "answered")
      .map((m) => ({ role: m.role, content: m.content.replace(/\[\[(ev|lv)_[A-Za-z0-9_-]+\]\]/g, "") }));

    const userRow = await repos.messages.add({ conversationId: c.id, customerId: ctx.customerId, role: "user", content });
    onEvent?.({ type: "run.started", runId: "pending", userMessage: toMessage(userRow) });
    const result = await this.deps.runtime.run(ctx, {
      agent,
      question: content,
      principalGroups: principal.groups,
      conversationId: c.id,
      history,
      signal,
      onEvent: (e) => onEvent?.(e),
    });
    const assistantRow = await repos.messages.add({
      conversationId: c.id,
      customerId: ctx.customerId,
      role: "assistant",
      content: result.content,
      status: result.status,
      citations: result.citations,
      model: result.model,
      toolCalls: result.toolCalls,
      proposalIds: result.proposalIds,
      runId: result.runId,
    });
    await repos.conversations.touch(c.id, c.title === "New conversation" ? content.slice(0, 80) : undefined);
    await repos.audit.write({
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      action: "agent.run",
      resourceType: "conversation",
      resourceId: c.id,
      outcome: result.status === "error" ? "error" : "ok",
      detail: {
        agentId: agent.id,
        agentVersion: agent.version,
        runId: result.runId,
        status: result.status,
        citations: result.citations.length,
        tools: result.toolCalls.map((t) => `${t.capabilityId}:${t.status}`),
        proposals: result.proposalIds.length,
      },
    });
    return { userMessage: toMessage(userRow), assistantMessage: toMessage(assistantRow) };
  }

  @Post("conversations/:id/messages")
  async post(@Ctx() ctx: TrustedContext, @Param("id") id: string, @Body() body: unknown): Promise<PostMessageResponse> {
    return this.turn(ctx, id, body);
  }

  /** Stops this conversation's in-flight run (the stored answer says it was cancelled). */
  @Post("conversations/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<{ cancelled: boolean }> {
    const c = await this.owned(ctx, id);
    const run = this.inflight.get(c.id);
    run?.abort(new DOMException("cancelled by the user", "AbortError"));
    return { cancelled: !!run };
  }

  /**
   * Streams run progress as server-sent events (run.started, tool.*, message).
   * Closing the connection only stops the stream: the run continues and its
   * answer is stored (see `turn`). The final message is validated (citations,
   * proposals) before it is sent, exactly as in the JSON endpoint.
   */
  @Post("conversations/:id/messages/stream")
  async stream(@Ctx() ctx: TrustedContext, @Param("id") id: string, @Body() body: unknown, @Res() res: Response): Promise<void> {
    PostMessageRequestSchema.parse(body); // validate before opening the stream
    await this.owned(ctx, id);
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    const send = (e: RunEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const keepAlive = setInterval(() => !res.writableEnded && res.write(": keep-alive\n\n"), 15_000);
    try {
      const r = await this.turn(ctx, id, body, { onEvent: send });
      send({ type: "message", assistantMessage: r.assistantMessage });
    } catch (err) {
      this.deps.logger.error({ requestId: ctx.requestId, err: (err as Error).name }, "stream run failed");
      send({
        type: "error",
        message: err instanceof ConflictException ? err.message : "The assistant could not complete this request.",
      });
    } finally {
      clearInterval(keepAlive);
      res.end();
    }
  }
}
