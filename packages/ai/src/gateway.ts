export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number };
  model: { provider: string; name: string };
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
