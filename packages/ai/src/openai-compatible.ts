import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { assertApprovedEndpoint, type ModelMode } from "@platform/security";
import { normalizeModelError, stripReasoning, type GenerateRequest, type GenerateResult, type ModelGateway } from "./gateway.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  mode: ModelMode;
  approvedEndpoints: readonly string[];
  timeoutMs: number;
  /** Test hook: replaces the network for both health checks and generation. */
  fetch?: typeof fetch;
}

/**
 * One configurable provider via the AI SDK's OpenAI-compatible adapter. Works
 * with local servers (vLLM, Ollama, llama.cpp) or an explicitly approved
 * hosted endpoint, such as Gemini's OpenAI-compatible API for testing without
 * local hardware (MODEL_MODE=hybrid). The endpoint is checked against the allowlist and, in
 * local mode, must be a local host; this happens before any request is made.
 */
export class OpenAICompatibleGateway implements ModelGateway {
  readonly descriptor: { provider: string; name: string };
  private readonly provider: ReturnType<typeof createOpenAICompatible>;

  constructor(private readonly o: OpenAICompatibleOptions) {
    assertApprovedEndpoint(o.baseUrl, o.approvedEndpoints, o.mode, "model endpoint");
    this.descriptor = { provider: `openai-compatible:${new URL(o.baseUrl).host}`, name: o.modelName };
    this.provider = createOpenAICompatible({ name: "platform-model", baseURL: o.baseUrl, apiKey: o.apiKey, ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  /** Lists the server's models (`GET /models`) and checks the configured one is served. No generation. */
  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/$/, "")}/models`, {
        headers: this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false, detail: `${this.descriptor.provider}: HTTP ${res.status}` };
      // Gemini lists "models/gemini-3.5-flash-lite"; Ollama and vLLM list the bare name.
      const ids = (((await res.json()) as { data?: { id?: string }[] }).data ?? []).map((m) => String(m.id ?? "").replace(/^models\//, ""));
      if (!ids.includes(this.o.modelName.replace(/^models\//, ""))) return { ok: false, detail: `${this.descriptor.provider}: model ${this.o.modelName} not available` };
      return { ok: true, detail: `${this.descriptor.provider}: ${this.o.modelName}` };
    } catch (err) {
      return { ok: false, detail: `${this.descriptor.provider}: ${(err as Error).name === "TimeoutError" ? "timeout" : "unreachable"}` };
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const tools: ToolSet | undefined = req.tools?.length
      ? Object.fromEntries(
          req.tools.map((t) => [
            t.name,
            tool({ description: t.description, inputSchema: jsonSchema(portableToolSchema(t.inputSchema)), execute: (input: unknown, o: { abortSignal?: AbortSignal }) => t.execute(input, { signal: o.abortSignal ?? signal }) }),
          ]),
        )
      : undefined;
    try {
      const res = await generateText({
        model: this.provider(this.o.modelName),
        system: req.system,
        messages: req.messages,
        maxOutputTokens: req.maxOutputTokens,
        temperature: 0,
        maxRetries: 1,
        abortSignal: signal,
        ...(tools ? { tools, stopWhen: stepCountIs(req.maxSteps ?? 4) } : {}),
      });
      const usage = (res as { totalUsage?: typeof res.usage }).totalUsage ?? res.usage;
      return {
        steps: res.steps?.length,
        text: stripReasoning(res.text),
        finishReason: String(res.finishReason),
        usage: { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens },
        model: this.descriptor,
      };
    } catch (err) {
      throw normalizeModelError(err, signal);
    }
  }
}

/** JSON Schema keywords every OpenAI-compatible provider accepts in tool parameters (Gemini's subset is the narrowest). */
const PORTABLE_KEYS = new Set(["type", "description", "properties", "required", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "anyOf", "nullable", "title"]);

/**
 * The tool's input schema as the model sees it: only portable keywords, so
 * providers that reject e.g. `additionalProperties` or `$schema` (Gemini)
 * accept it. This only guides the model: the runtime validates every call
 * against the full schema on the server (ADR 0007), so nothing is loosened.
 */
export function portableToolSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "properties" && v && typeof v === "object") {
        out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, strip(sub)]));
      } else if (PORTABLE_KEYS.has(k)) {
        out[k] = strip(v);
      }
    }
    return out;
  };
  return strip(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as Record<string, unknown>;
}
