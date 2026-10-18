import type { DocumentView, Evidence } from "@platform/contracts";
import type { Principal, TrustedContext } from "@platform/security";

/** Catalog entry owned by the platform (not by the RAG backend). */
export interface CatalogDocument {
  customerId: string;
  documentId: string;
  sourceId: string;
  version: string;
  title: string;
  sourceUrl?: string;
  aclGroups: readonly string[];
  aclRevision: number;
  externalRef: Readonly<Record<string, string>>;
  indexedAt: Date;
  tombstoned: boolean;
}

export interface DocumentCatalog {
  /** Prefilter: non-tombstoned documents in the given sources whose ACL intersects the groups. */
  listReadable(customerId: string, groups: readonly string[], sourceIds: readonly string[]): Promise<CatalogDocument[]>;
  get(customerId: string, documentId: string): Promise<CatalogDocument | undefined>;
}

export interface PrincipalDirectory {
  get(customerId: string, principalId: string): Promise<Principal | undefined>;
}

export interface IssuedEvidence {
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

export interface EvidenceLedger {
  record(rows: IssuedEvidence[]): Promise<void>;
  get(customerId: string, evidenceId: string): Promise<IssuedEvidence | undefined>;
}

/** What an adapter is allowed to see: only documents already authorized for this request. */
export interface AdapterSearchRequest {
  query: string;
  limit: number;
  documents: readonly CatalogDocument[];
  signal?: AbortSignal;
}

export interface AdapterChunk {
  documentId: string;
  chunkId: string;
  text: string;
  location?: string;
  /** Relevance in [0, 1]; adapters normalize their native scores. */
  score: number;
}

export interface KnowledgeAdapter {
  readonly name: string;
  search(req: AdapterSearchRequest): Promise<AdapterChunk[]>;
  getDocumentChunks(doc: CatalogDocument, signal?: AbortSignal): Promise<AdapterChunk[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export interface SearchInput {
  query: string;
  limit: number;
  /** Server-defined agent scope. Never taken from model output or client input. */
  sourceIds?: readonly string[];
  runId?: string;
}

/** The owned contract every agent and API route uses. */
export interface KnowledgeService {
  search(ctx: TrustedContext, input: SearchInput): Promise<Evidence[]>;
  getDocument(ctx: TrustedContext, documentId: string): Promise<DocumentView>;
  resolveEvidence(ctx: TrustedContext, evidenceId: string): Promise<IssuedEvidence>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class KnowledgeBackendError extends Error {
  constructor(
    readonly kind: "unavailable" | "invalid_response" | "denied" | "throttled" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBackendError";
  }
}
