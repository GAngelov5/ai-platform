/** Normalized connector failure vocabulary (handoff §4). */
export type ConnectorErrorKind = "denied" | "unavailable" | "throttled" | "invalid_input" | "ambiguous_outcome";

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    readonly connectorId?: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface ConnectorCallOptions {
  signal?: AbortSignal;
  /** Required for writes: the timeout of a write maps to `ambiguous_outcome`, never to a silent retry. */
  classification: "read" | "write";
}

export interface ConnectorResult {
  /** Parsed structured result (bounded). Untrusted data. */
  data: unknown;
  /** Textual form for model context (bounded). Untrusted data. */
  text: string;
}

export interface ConnectorToolStatus {
  name: string;
  enabled: boolean;
  reason?: string;
}

export interface Connector {
  readonly id: string;
  readonly kind: "mcp" | "graph" | "oauth";
  call(tool: string, args: Record<string, unknown>, opts: ConnectorCallOptions): Promise<ConnectorResult>;
  /** Tools that passed pinning/allowlist checks. */
  tools(): Promise<ConnectorToolStatus[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
  close(): Promise<void>;
}
