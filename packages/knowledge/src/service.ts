import { randomBytes } from "node:crypto";
import type { DocumentView, Evidence } from "@platform/contracts";
import { canReadDocument, NotFoundOrForbiddenError, type Principal, type TrustedContext } from "@platform/security";
import type {
  CatalogDocument,
  DocumentCatalog,
  EvidenceLedger,
  IssuedEvidence,
  KnowledgeAdapter,
  KnowledgeService,
  PrincipalDirectory,
  SearchInput,
} from "./types.js";
import { supersededVersions } from "./versions.js";

export interface KnowledgeServiceOptions {
  catalog: DocumentCatalog;
  principals: PrincipalDirectory;
  ledger: EvidenceLedger;
  adapter: KnowledgeAdapter;
  /** Application policy: sources this deployment allows to be searched at all. */
  policySourceIds: readonly string[];
  maxExcerptChars?: number;
  onSecurityEvent?: (event: { type: string; ctx: TrustedContext; detail: Record<string, unknown> }) => void;
}

export const newEvidenceId = () => `ev_${randomBytes(12).toString("base64url")}`;

/**
 * Enforces permissions inside the trusted knowledge boundary:
 *   principal (reloaded from storage) ∩ application policy ∩ agent scope ∩ source ACL
 * is resolved BEFORE the adapter is called, the adapter receives only authorized
 * documents, and every returned chunk is re-verified before it leaves this class.
 */
export class PolicyEnforcingKnowledgeService implements KnowledgeService {
  private readonly maxExcerpt: number;

  constructor(private readonly o: KnowledgeServiceOptions) {
    this.maxExcerpt = o.maxExcerptChars ?? 1200;
  }

  private async principal(ctx: TrustedContext): Promise<Principal> {
    const p = await this.o.principals.get(ctx.customerId, ctx.principalId);
    if (!p || p.disabled || p.customerId !== ctx.customerId) {
      throw new NotFoundOrForbiddenError();
    }
    return p;
  }

  private scope(input?: readonly string[]): string[] {
    const policy = this.o.policySourceIds;
    return input ? input.filter((s) => policy.includes(s)) : [...policy];
  }

  async search(ctx: TrustedContext, input: SearchInput): Promise<Evidence[]> {
    const principal = await this.principal(ctx);
    const sourceIds = this.scope(input.sourceIds);
    const candidates = await this.o.catalog.listReadable(ctx.customerId, principal.groups, sourceIds);
    const authorized = new Map<string, CatalogDocument>();
    for (const d of candidates) {
      if (canReadDocument(principal, d, sourceIds)) authorized.set(d.documentId, d);
    }
    if (authorized.size === 0) return []; // fail closed: never search an unscoped backend

    const limit = Math.max(1, Math.min(input.limit, 20));
    const raw = await this.o.adapter.search({ query: input.query, limit, documents: [...authorized.values()] });
    // Backend-independent version handling: superseded versions move after current
    // ones. Otherwise the backend's order and scores are kept (stable sort), so old
    // versions stay usable evidence for "what changed" questions.
    const superseded = supersededVersions([...authorized.values()]);
    const chunks = [...raw].sort((a, b) => Number(superseded.has(a.documentId)) - Number(superseded.has(b.documentId)));

    const evidence: Evidence[] = [];
    const ledger: IssuedEvidence[] = [];
    for (const c of chunks) {
      const doc = authorized.get(c.documentId);
      if (!doc) {
        // Defense in depth: adapter returned something outside the prefilter. Drop it.
        this.o.onSecurityEvent?.({ type: "adapter_returned_unauthorized_chunk", ctx, detail: { adapter: this.o.adapter.name } });
        continue;
      }
      if (evidence.length >= limit) break;
      const ev: Evidence = {
        evidenceId: newEvidenceId(),
        sourceId: doc.sourceId,
        documentId: doc.documentId,
        version: doc.version,
        chunkId: c.chunkId,
        title: doc.title,
        location: c.location,
        sourceUrl: doc.sourceUrl,
        indexedAt: doc.indexedAt.toISOString(),
        excerpt: c.text.slice(0, this.maxExcerpt),
        score: Math.max(0, Math.min(1, c.score)),
        ...(superseded.has(doc.documentId) ? { supersededBy: superseded.get(doc.documentId) } : {}),
      };
      evidence.push(ev);
      ledger.push({
        evidenceId: ev.evidenceId,
        customerId: ctx.customerId,
        principalId: ctx.principalId,
        runId: input.runId ?? null,
        requestId: ctx.requestId,
        sourceId: ev.sourceId,
        documentId: ev.documentId,
        version: ev.version,
        chunkId: ev.chunkId,
        title: ev.title,
        location: ev.location,
        sourceUrl: ev.sourceUrl,
        indexedAt: doc.indexedAt,
        excerpt: ev.excerpt,
      });
    }
    await this.o.ledger.record(ledger);
    return evidence;
  }

  private async readableDocument(ctx: TrustedContext, principal: Principal, documentId: string): Promise<CatalogDocument> {
    const doc = await this.o.catalog.get(ctx.customerId, documentId);
    if (!doc || !canReadDocument(principal, doc, this.o.policySourceIds)) {
      this.o.onSecurityEvent?.({ type: "document_access_denied", ctx, detail: { documentId } });
      throw new NotFoundOrForbiddenError();
    }
    return doc;
  }

  async getDocument(ctx: TrustedContext, documentId: string): Promise<DocumentView> {
    const principal = await this.principal(ctx);
    const doc = await this.readableDocument(ctx, principal, documentId);
    const chunks = await this.o.adapter.getDocumentChunks(doc);
    return {
      documentId: doc.documentId,
      sourceId: doc.sourceId,
      version: doc.version,
      title: doc.title,
      sourceUrl: doc.sourceUrl,
      indexedAt: doc.indexedAt.toISOString(),
      chunks: chunks.map((c) => ({ chunkId: c.chunkId, location: c.location, text: c.text })),
    };
  }

  /** Citations resolve only for the principal they were issued to, and only while access still holds. */
  async resolveEvidence(ctx: TrustedContext, evidenceId: string): Promise<IssuedEvidence> {
    const principal = await this.principal(ctx);
    const issued = await this.o.ledger.get(ctx.customerId, evidenceId);
    if (!issued || issued.principalId !== ctx.principalId) throw new NotFoundOrForbiddenError();
    await this.readableDocument(ctx, principal, issued.documentId);
    return issued;
  }

  /** Re-checks current access for stored citations (permission changes affect history). */
  async filterReadableDocumentIds(ctx: TrustedContext, documentIds: readonly string[]): Promise<Set<string>> {
    const principal = await this.principal(ctx);
    const ok = new Set<string>();
    for (const id of new Set(documentIds)) {
      const doc = await this.o.catalog.get(ctx.customerId, id);
      if (doc && canReadDocument(principal, doc, this.o.policySourceIds)) ok.add(id);
    }
    return ok;
  }

  health() {
    return this.o.adapter.health();
  }
}
