import { CapabilityRegistry } from "@platform/agents";
import {
  ConnectorRegistry,
  GoogleCalendarConnector,
  GoogleOAuthClient,
  McpConnector,
  McpServersSchema,
  PersonalConnectionStore,
  registerAtlasTrackerCapabilities,
  registerCalendarCapabilities,
  type GoogleEndpoints,
  type SealedConnectionRows,
} from "@platform/connectors";
import { SecretSealer } from "@platform/security";
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
  /** Personal Google connections (ADR 0015). When set, the user's Google Calendar backs calendar.events.list. */
  google?: {
    customerId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    encryptionKey: string;
    rows: SealedConnectionRows;
    /** Tests only: a local fake of Google's endpoints. */
    endpoints?: GoogleEndpoints;
  };
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
  let google: { oauth: GoogleOAuthClient; store: PersonalConnectionStore } | undefined;
  if (i.google) {
    const g = i.google;
    const oauth = new GoogleOAuthClient({ clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: g.redirectUri }, g.endpoints);
    const store = new PersonalConnectionStore(g.rows, new SecretSealer(g.encryptionKey));
    const c = new GoogleCalendarConnector({ customerId: g.customerId, oauth, store, endpoints: g.endpoints });
    connectors.register(c);
    registerCalendarCapabilities(capabilities, c);
    google = { oauth, store };
  }
  for (const srv of servers) {
    const token = i.secret(i.tokenVar(srv.id));
    if (!token) throw new Error(`missing token for MCP server ${srv.id}`);
    const c = new McpConnector(srv, token, i.onSecurityEvent);
    connectors.register(c);
    // Capability bindings are platform code keyed by server id; unknown servers expose nothing.
    if (srv.id === "atlas-tracker") registerAtlasTrackerCapabilities(capabilities, c);
    else if (srv.id === "calendar") {
      // A real calendar wins over the synthetic one: one capability, one source of truth.
      if (google) i.log?.("Google Calendar is configured; the synthetic calendar MCP is not exposed", { server: srv.id });
      else registerCalendarCapabilities(capabilities, c);
    }
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
  return { connectors, capabilities, actions, google };
}
