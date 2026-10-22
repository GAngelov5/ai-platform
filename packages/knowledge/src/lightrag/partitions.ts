import { z } from "zod";
import type { CatalogDocument } from "../types.js";

/**
 * An access partition is one LightRAG server/workspace that holds only
 * documents from one source with one exact ACL group set.
 */
/**
 * A partition holds documents with one exact ACL set, from one or more sources
 * (ADR 0009: partitions per access set, not per source).
 */
export const LightRagPartitionSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    url: z.string().url(),
    sourceId: z.string().min(1).optional(),
    sourceIds: z.array(z.string().min(1)).min(1).optional(),
    aclGroups: z.array(z.string().min(1)).min(1),
  })
  .refine((p) => !!p.sourceId !== !!p.sourceIds, "set exactly one of sourceId or sourceIds")
  .transform(({ sourceId, sourceIds, ...rest }) => ({ ...rest, sourceIds: sourceIds ?? [sourceId!] }));
export type LightRagPartition = z.output<typeof LightRagPartitionSchema>;

export const LightRagPartitionsSchema = z
  .array(LightRagPartitionSchema)
  .min(1)
  .superRefine((parts, ctx) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const p of parts) {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", message: `duplicate partition id ${p.id}` });
      ids.add(p.id);
      for (const src of p.sourceIds) {
        const k = partitionKey(src, p.aclGroups);
        if (keys.has(k)) ctx.addIssue({ code: "custom", message: `two partitions accept source+ACL ${k}` });
        keys.add(k);
      }
    }
  });

export const LIGHTRAG_REF_PARTITION = "lightragPartition";
export const LIGHTRAG_REF_DOC_ID = "lightragDocId";
export const LIGHTRAG_REF_FILE_SOURCE = "lightragFileSource";

export const partitionKey = (sourceId: string, groups: readonly string[]) => `${sourceId}|${[...new Set(groups)].sort().join(",")}`;

/** The only partition a document may live in: its source is accepted and the ACL set is identical. */
export function partitionFor(doc: Pick<CatalogDocument, "sourceId" | "aclGroups">, partitions: readonly LightRagPartition[]): LightRagPartition | undefined {
  if (doc.aclGroups.length === 0) return undefined; // no readers: never indexed
  const k = partitionKey(doc.sourceId, doc.aclGroups);
  return partitions.find((p) => p.sourceIds.some((s) => partitionKey(s, p.aclGroups) === k));
}

/** Stable, version-specific name used as LightRAG's file_source. */
export const fileSourceFor = (doc: Pick<CatalogDocument, "documentId" | "version">) =>
  `${doc.documentId}__${doc.version}.md`.replace(/[^A-Za-z0-9._-]/g, "_");
