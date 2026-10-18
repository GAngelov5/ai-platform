import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { assertApprovedEndpoint, type ModelMode } from "@platform/security";
import { normalizeModelError, type GenerateRequest, type GenerateResult, type ModelGateway } from "./gateway.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  mode: ModelMode;
  approvedEndpoints: readonly string[];
  timeoutMs: number;
}

/**
 * One configurable provider via the AI SDK's OpenAI-compatible adapter. Works
 * with local servers (vLLM, Ollama, llama.cpp) or an explicitly approved
 * hosted endpoint. The endpoint is checked against the allowlist and, in
 * local mode, must be a local host; this happens before any request is made.
 */
export class OpenAICompatibleGateway implements ModelGateway {
  readonly descriptor: { provider: string; name: string };
  private readonly provider: ReturnType<typeof createOpenAICompatible>;

  constructor(private readonly o: OpenAICompatibleOptions) {
    assertApprovedEndpoint(o.baseUrl, o.approvedEndpoints, o.mode, "model endpoint");
    this.descriptor = { provider: `openai-compatible:${new URL(o.baseUrl).host}`, name: o.modelName };
    this.provider = createOpenAICompatible({ name: "platform-model", baseURL: o.baseUrl, apiKey: o.apiKey });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    try {
      const res = await generateText({
        model: this.provider(this.o.modelName),
        system: req.system,
        messages: req.messages,
        maxOutputTokens: req.maxOutputTokens,
        temperature: 0,
        maxRetries: 1,
        abortSignal: signal,
      });
      return {
        text: res.text,
        finishReason: String(res.finishReason),
        usage: { inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens },
        model: this.descriptor,
      };
    } catch (err) {
      throw normalizeModelError(err, signal);
    }
  }
}
