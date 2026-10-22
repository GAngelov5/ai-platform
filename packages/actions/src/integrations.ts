import { CapabilityRegistry } from "@platform/agents";
import { ConnectorRegistry, McpConnector, McpServersSchema, registerAtlasTrackerCapabilities, registerCalendarCapabilities } from "@platform/connectors";
import type { AuditInput, Database, PrincipalRecord } from "@platform/database";
import { ActionService } from "./index.js";

export interface IntegrationsInput {
  db: Database;
  mcpServersJson?: string;
  /** Resolves a secret by reference (env var name); never from model or client input. */
  secret: (name: string) => string | undefined;
  tokenVar: (serverId: string) => string;
  principals: { get(customerId: string, principalId: string): Promise<PrincipalRecord | undefined> };
  audit: { write(e: AuditInput): Promise<void> };
  proposalTtlMinutes: number;
  onSecurityEvent?: (type: string, detail: Record<string, unknown>) => void;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}

/**
 * Builds the connector registry, capability registry and ActionService from
 * deployment configuration. Used identically by the API (propose/approve) and
 * the worker (execute/reconcile).
 */
export function buildIntegrations(i: IntegrationsInput) {
  const connectors = new ConnectorRegistry();
  const capabilities = new CapabilityRegistry();
  const servers = i.mcpServersJson ? McpServersSchema.parse(JSON.parse(i.mcpServersJson)) : [];
  for (const srv of servers) {
    const token = i.secret(i.tokenVar(srv.id));
    if (!token) throw new Error(`missing token for MCP server ${srv.id}`);
    const c = new McpConnector(srv, token, i.onSecurityEvent);
    connectors.register(c);
    // Capability bindings are platform code keyed by server id; unknown servers expose nothing.
    if (srv.id === "atlas-tracker") registerAtlasTrackerCapabilities(capabilities, c);
    else if (srv.id === "calendar") registerCalendarCapabilities(capabilities, c);
    else i.log?.("MCP server has no capability bindings; nothing exposed", { server: srv.id });
  }
  const actions = new ActionService({
    db: i.db,
    capabilities,
    connectors,
    principals: i.principals,
    audit: i.audit,
    ttlMs: i.proposalTtlMinutes * 60_000,
    log: i.log,
  });
  return { connectors, capabilities, actions };
}
