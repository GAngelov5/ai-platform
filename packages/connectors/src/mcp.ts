import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { canonicalHash, isLocalHostname } from "@platform/security";
import { z } from "zod";
import { ConnectorError, type Connector, type ConnectorCallOptions, type ConnectorResult, type ConnectorToolStatus } from "./types.js";

export const McpServerConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  url: z.string().url(),
  /** Reviewed tool definitions: name -> sha256 of the canonical {name, description, inputSchema}. */
  pinnedTools: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  timeoutMs: z.number().int().min(500).max(120_000).default(15_000),
  maxResponseBytes: z.number().int().min(256).max(1_000_000).default(16_384),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServersSchema = z.array(McpServerConfigSchema).refine((a) => new Set(a.map((s) => s.id)).size === a.length, "duplicate MCP server id");

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** Hash used for pinning. Any change to name, description or input schema changes it. */
export const mcpToolHash = (t: McpToolDefinition) => canonicalHash({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });

/**
 * Allowlisted MCP server connection (Streamable HTTP).
 * - Only tools whose live definition matches a reviewed pin are callable.
 * - Credentials are an audience-bound token for this server only; user tokens are never passed through.
 * - Response size is bounded; results are untrusted data.
 */
export class McpConnector implements Connector {
  readonly kind = "mcp" as const;
  readonly id: string;
  private client?: Client;
  private status?: Map<string, ConnectorToolStatus>;
  private connecting?: Promise<void>;

  constructor(
    private readonly cfg: McpServerConfig,
    private readonly token: string,
    private readonly onSecurityEvent: (type: string, detail: Record<string, unknown>) => void = () => {},
  ) {
    this.id = cfg.id;
    if (!isLocalHostname(new URL(cfg.url).hostname)) {
      throw new Error(`MCP server ${cfg.id} must be on the private network`);
    }
  }

  private async connect(): Promise<void> {
    if (this.client && this.status) return;
    this.connecting ??= (async () => {
      const client = new Client({ name: "ai-platform", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), {
        requestInit: { headers: { Authorization: `Bearer ${this.token}` }, redirect: "error" },
      });
      try {
        await client.connect(transport, { timeout: this.cfg.timeoutMs });
        const listed = await client.listTools(undefined, { timeout: this.cfg.timeoutMs });
        const status = new Map<string, ConnectorToolStatus>();
        for (const t of listed.tools) {
          const pin = this.cfg.pinnedTools[t.name];
          if (!pin) {
            status.set(t.name, { name: t.name, enabled: false, reason: "not allowlisted" });
            continue;
          }
          const actual = mcpToolHash(t);
          if (actual !== pin) {
            this.onSecurityEvent("mcp_tool_pin_mismatch", { server: this.id, tool: t.name });
            status.set(t.name, { name: t.name, enabled: false, reason: "definition changed since review (pin mismatch)" });
            continue;
          }
          status.set(t.name, { name: t.name, enabled: true });
        }
        for (const name of Object.keys(this.cfg.pinnedTools)) {
          if (!status.has(name)) status.set(name, { name, enabled: false, reason: "pinned tool not offered by server" });
        }
        this.client = client;
        this.status = status;
      } catch (err) {
        await client.close().catch(() => {});
        throw mapError(err, "read", this.id);
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  async tools(): Promise<ConnectorToolStatus[]> {
    await this.connect();
    return [...this.status!.values()];
  }

  async call(tool: string, args: Record<string, unknown>, opts: ConnectorCallOptions): Promise<ConnectorResult> {
    await this.connect();
    const st = this.status!.get(tool);
    if (!st?.enabled) throw new ConnectorError("denied", `tool ${tool} is not enabled (${st?.reason ?? "unknown tool"})`, this.id);
    let res: Awaited<ReturnType<Client["callTool"]>>;
    try {
      res = await this.client!.callTool({ name: tool, arguments: args }, undefined, { timeout: this.cfg.timeoutMs, signal: opts.signal });
    } catch (err) {
      // Drop the session so the next call reconnects cleanly.
      await this.close();
      throw mapError(err, opts.classification, this.id);
    }
    const text = (Array.isArray(res.content) ? res.content : [])
      .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("\n");
    if (Buffer.byteLength(text, "utf8") > this.cfg.maxResponseBytes) {
      throw new ConnectorError(opts.classification === "write" ? "ambiguous_outcome" : "unavailable", `response from ${tool} exceeds ${this.cfg.maxResponseBytes} bytes`, this.id);
    }
    if (res.isError) throw new ConnectorError("invalid_input", `tool ${tool} rejected the request: ${text.slice(0, 300)}`, this.id);
    let data: unknown = res.structuredContent;
    if (data === undefined) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { data, text };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const t = await this.tools();
      const enabled = t.filter((x) => x.enabled).length;
      return { ok: enabled > 0, detail: `${enabled}/${t.length} tools enabled` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.status = undefined;
    await c?.close().catch(() => {});
  }
}

function mapError(err: unknown, classification: "read" | "write", connectorId: string): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const e = err as { name?: string; code?: number; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === 401 || e?.code === 403 || /\b40[13]\b/.test(msg)) return new ConnectorError("denied", "MCP server rejected credentials", connectorId);
  if (e?.code === 429 || /\b429\b/.test(msg)) return new ConnectorError("throttled", "MCP server throttled the request", connectorId);
  const timeout = e?.name === "TimeoutError" || e?.name === "AbortError" || /timed? ?out/i.test(msg) || e?.code === -32001;
  if (classification === "write" && (timeout || /fetch failed|ECONNRESET|socket/i.test(msg))) {
    // The write may have happened. Never retry blindly; reconcile instead.
    return new ConnectorError("ambiguous_outcome", `write outcome unknown: ${msg.slice(0, 200)}`, connectorId);
  }
  if (e?.code === -32602) return new ConnectorError("invalid_input", msg.slice(0, 300), connectorId);
  return new ConnectorError("unavailable", `MCP server unavailable: ${msg.slice(0, 200)}`, connectorId);
}

/** Lists a server's live tool definitions with their pin hashes, for operator review. */
export async function fetchMcpToolPins(url: string, token: string, timeoutMs = 10_000): Promise<{ name: string; description?: string; sha256: string }[]> {
  const client = new Client({ name: "ai-platform-pin-review", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" } });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    return listed.tools.map((t) => ({ name: t.name, description: t.description, sha256: mcpToolHash(t) }));
  } finally {
    await client.close().catch(() => {});
  }
}
