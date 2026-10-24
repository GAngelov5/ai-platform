import { z } from "zod";

/** One item as the source system describes it. ACL groups are in the source's own terms. */
export interface SourceItem {
  /** Stable ID within the source (path, item ID). */
  externalId: string;
  /** Changes whenever content changes (etag, version number, mtime+size). */
  version: string;
  title: string;
  url?: string;
  modifiedAt: Date;
  mimeType: string;
  size: number;
  acl: { groups: string[] };
}

export type SourceChange = { kind: "upsert"; item: SourceItem } | { kind: "delete"; externalId: string };

export interface SourceChangeSet {
  changes: SourceChange[];
  cursor: string;
  /** True when `changes` lists every current item; anything not listed is deleted. */
  full: boolean;
}

/**
 * The only system-specific part of indexing (ADR 0009): how to list changes,
 * fetch content and read native permissions. Everything else is generic.
 */
export interface SourceAdapter {
  readonly kind: string;
  listChanges(cursor: string | null, signal?: AbortSignal): Promise<SourceChangeSet>;
  fetchContent(item: SourceItem, signal?: AbortSignal): Promise<string | Uint8Array>;
}

export const SourceConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  title: z.string().min(1).max(100),
  kind: z.enum(["fixture", "folder", "notion"]),
  /** Adapter-specific settings: { path } for a folder; { tokenVar } (env var name, default NOTION_TOKEN) for Notion. */
  settings: z.record(z.string(), z.string()).default({}),
  /** Native group -> platform group. Unmapped native groups are dropped. */
  aclMap: z.record(z.string(), z.string()).default({}),
  /** Native groups are already platform groups (synthetic fixtures only). */
  aclPassThrough: z.boolean().default(false),
  /** Prefix document IDs with the source ID (on for real sources). */
  prefixDocumentIds: z.boolean().default(true),
  maxBytes: z.number().int().min(1024).max(50 * 1024 * 1024).default(5 * 1024 * 1024),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const SourcesConfigSchema = z
  .array(SourceConfigSchema)
  .refine((a) => new Set(a.map((s) => s.id)).size === a.length, "duplicate source id");

export type QuarantineReason = "unsupported_type" | "too_large" | "empty" | "parse_error" | "parse_timeout" | "needs_ocr" | "fetch_error";
