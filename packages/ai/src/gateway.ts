export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

/** A server-built tool offered to the model for one run. `execute` is the platform's guarded wrapper. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: import("zod").ZodType;
  execute(input: unknown, opts: { signal?: AbortSignal }): Promise<unknown>;
}

export interface GenerateRequest {
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  tools?: ModelTool[];
  /** Upper bound on model steps (tool rounds + final answer). */
  maxSteps?: number;
}

export interface GenerateResult {
  text: string;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number };
  model: { provider: string; name: string };
  steps?: number;
}

/** Removes model reasoning traces (e.g. Qwen3 <think> blocks); they are never shown or stored. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

export type ModelErrorKind = "timeout" | "cancelled" | "unavailable" | "rejected" | "invalid_config";

export class ModelGatewayError extends Error {
  constructor(readonly kind: ModelErrorKind, message: string) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

/** Provider-neutral model boundary. Provider specifics stay behind implementations. */
export interface ModelGateway {
  readonly descriptor: { provider: string; name: string };
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Cheap reachability probe for readiness (must not run a generation). */
  health?(): Promise<{ ok: boolean; detail?: string }>;
}

export function normalizeModelError(err: unknown, signal?: AbortSignal): ModelGatewayError {
  if (err instanceof ModelGatewayError) return err;
  const e = err as { name?: string; statusCode?: number; message?: string };
  if (signal?.aborted) {
    const reason = signal.reason as { name?: string } | undefined;
    return reason?.name === "TimeoutError"
      ? new ModelGatewayError("timeout", "model call exceeded the run time budget")
      : new ModelGatewayError("cancelled", "model call cancelled");
  }
  if (e?.name === "TimeoutError") return new ModelGatewayError("timeout", "model call timed out");
  if (e?.name === "AbortError") return new ModelGatewayError("cancelled", "model call cancelled");
  if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
    return new ModelGatewayError("rejected", `model endpoint rejected the request (${e.statusCode})`);
  }
  return new ModelGatewayError("unavailable", "model endpoint unavailable");
}
