/** A principal as loaded from platform storage (never from client input). */
export interface Principal {
  id: string;
  customerId: string;
  displayName: string;
  groups: readonly string[];
  roles: readonly string[];
  disabled: boolean;
}

/** Source-level access metadata captured during ingestion. */
export interface DocumentAccess {
  customerId: string;
  sourceId: string;
  aclGroups: readonly string[];
  tombstoned: boolean;
}

/**
 * Document-level access decision. Fails closed: an empty ACL, a tombstoned
 * document, a disabled principal or a customer mismatch denies access.
 */
export function canReadDocument(
  principal: Principal,
  doc: DocumentAccess,
  allowedSourceIds?: readonly string[],
): boolean {
  if (principal.disabled) return false;
  if (principal.customerId !== doc.customerId) return false;
  if (doc.tombstoned) return false;
  if (allowedSourceIds && !allowedSourceIds.includes(doc.sourceId)) return false;
  if (doc.aclGroups.length === 0) return false;
  return doc.aclGroups.some((g) => principal.groups.includes(g));
}

/**
 * Intersects agent knowledge scopes with application policy. Returns the
 * source IDs the runtime may search on behalf of this principal and agent.
 */
export function intersectSourceScopes(
  agentSourceIds: readonly string[],
  policySourceIds: readonly string[],
): string[] {
  return agentSourceIds.filter((s) => policySourceIds.includes(s));
}
