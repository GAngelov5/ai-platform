/**
 * Connector contracts (Microsoft Graph direct adapter, allowlisted MCP client).
 * NOT IMPLEMENTED in Phase 1 — scheduled for Phase 5. This package only fixes
 * the error vocabulary so later adapters normalize failures consistently.
 */
export type ConnectorErrorKind = "denied" | "unavailable" | "throttled" | "invalid_input" | "ambiguous_outcome";

export interface ConnectorCapabilityDescriptor {
  id: string;
  version: string;
  classification: "read" | "write";
  requiredPermissions: string[];
  timeoutMs: number;
  retry: "safe" | "never" | "reconcile_first";
}

export const CONNECTORS_IMPLEMENTED = false as const;
