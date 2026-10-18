import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  CreateConversationRequestSchema,
  PostMessageRequestSchema,
  type AgentSummary,
  type AnswerStatus,
  type ConversationDetail,
  type ConversationSummary,
  type Message,
  type PostMessageResponse,
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
  createdAt: m.createdAt.toISOString(),
});

@Controller()
export class ConversationsController {
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
    const cited = rows.flatMap((m) => m.citations.map((c) => c.documentId));
    const readable = await this.deps.knowledge.filterReadableDocumentIds(ctx, cited);
    return rows.map((m) => {
      const msg = toMessage(m);
      if (m.role === "assistant" && m.citations.some((c) => !readable.has(c.documentId))) {
        return { ...msg, content: WITHHELD, citations: [], status: "withheld" };
      }
      return msg;
    });
  }

  @Get("conversations/:id")
  async get(@Ctx() ctx: TrustedContext, @Param("id") id: string): Promise<ConversationDetail> {
    const c = await this.owned(ctx, id);
    const rows = await this.deps.repos.messages.list(ctx.customerId, c.id);
    return { ...summary(c), messages: await this.visibleMessages(ctx, rows) };
  }

  @Post("conversations/:id/messages")
  async post(@Ctx() ctx: TrustedContext, @Param("id") id: string, @Body() body: unknown): Promise<PostMessageResponse> {
    const { content } = PostMessageRequestSchema.parse(body);
    const c = await this.owned(ctx, id);
    const agent = this.deps.agents.get(c.agentId);
    if (!agent) throw new NotFoundOrForbiddenError();
    const { repos } = this.deps;

    const prior = await this.visibleMessages(ctx, await repos.messages.list(ctx.customerId, c.id));
    const history = prior
      .filter((m) => m.role === "user" || m.status === "answered")
      .map((m) => ({ role: m.role, content: m.content.replace(/\[\[ev_[A-Za-z0-9_-]+\]\]/g, "") }));

    const userRow = await repos.messages.add({ conversationId: c.id, customerId: ctx.customerId, role: "user", content });
    const result = await this.deps.runtime.run(ctx, { agent, question: content, conversationId: c.id, history });
    const assistantRow = await repos.messages.add({
      conversationId: c.id,
      customerId: ctx.customerId,
      role: "assistant",
      content: result.content,
      status: result.status,
      citations: result.citations,
      model: result.model,
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
      detail: { agentId: agent.id, agentVersion: agent.version, runId: result.runId, status: result.status, citations: result.citations.length },
    });
    return { userMessage: toMessage(userRow), assistantMessage: toMessage(assistantRow) };
  }
}
