import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { IdSchema, KnowledgeSearchRequestSchema, type DocumentView, type EvidenceResolution, type KnowledgeSearchResponse } from "@platform/contracts";
import { NotFoundOrForbiddenError, type TrustedContext } from "@platform/security";
import { Ctx } from "../auth/decorators.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

@Controller("knowledge")
export class KnowledgeController {
  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  @Post("search")
  @HttpCode(200)
  async search(@Ctx() ctx: TrustedContext, @Body() body: unknown): Promise<KnowledgeSearchResponse> {
    const input = KnowledgeSearchRequestSchema.parse(body);
    const evidence = await this.deps.knowledge.search(ctx, { query: input.query, limit: input.limit });
    await this.deps.repos.audit.write({
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      action: "knowledge.search",
      outcome: "ok",
      detail: { resultCount: evidence.length, queryChars: input.query.length },
    });
    return { evidence };
  }

  @Get("documents/:documentId")
  async document(@Ctx() ctx: TrustedContext, @Param("documentId") documentId: string): Promise<DocumentView> {
    if (!IdSchema.safeParse(documentId).success) throw new NotFoundOrForbiddenError();
    const view = await this.deps.knowledge.getDocument(ctx, documentId);
    await this.deps.repos.audit.write({
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      action: "knowledge.document_view",
      resourceType: "document",
      resourceId: documentId,
      outcome: "allowed",
    });
    return view;
  }

  @Get("evidence/:evidenceId")
  async evidence(@Ctx() ctx: TrustedContext, @Param("evidenceId") evidenceId: string): Promise<EvidenceResolution> {
    if (!/^ev_[A-Za-z0-9_-]{8,64}$/.test(evidenceId)) throw new NotFoundOrForbiddenError();
    const e = await this.deps.knowledge.resolveEvidence(ctx, evidenceId);
    return {
      evidence: {
        evidenceId: e.evidenceId,
        sourceId: e.sourceId,
        documentId: e.documentId,
        version: e.version,
        chunkId: e.chunkId,
        title: e.title,
        location: e.location,
        sourceUrl: e.sourceUrl,
        indexedAt: e.indexedAt.toISOString(),
        excerpt: e.excerpt,
      },
      documentPath: `/documents/${encodeURIComponent(e.documentId)}#${encodeURIComponent(e.chunkId)}`,
    };
  }
}
