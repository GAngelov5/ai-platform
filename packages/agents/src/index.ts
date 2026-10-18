import { z } from "zod";
import { IdSchema } from "@platform/contracts";

/** Capabilities the runtime knows how to grant. Unknown capabilities are rejected at registration. */
export const CapabilitySchema = z.enum(["knowledge.search"]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const AgentDefinitionSchema = z.strictObject({
  id: IdSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  instructions: z.string().min(1).max(8000),
  capabilities: z.array(CapabilitySchema).min(1),
  knowledgeScopes: z.strictObject({ sourceIds: z.array(IdSchema).min(1) }),
  outputSchema: z.literal("cited-answer@1"),
  limits: z.strictObject({
    maxToolCalls: z.number().int().min(1).max(10),
    maxEvidence: z.number().int().min(1).max(20),
    minEvidenceScore: z.number().min(0).max(1),
    maxInputChars: z.number().int().min(100).max(8000),
    maxOutputTokens: z.number().int().min(64).max(4096),
    maxOutputChars: z.number().int().min(200).max(20000),
    maxDurationMs: z.number().int().min(1000).max(300000),
  }),
});
export type AgentDefinition = Readonly<z.infer<typeof AgentDefinitionSchema>>;

export function defineAgent(def: z.input<typeof AgentDefinitionSchema>): AgentDefinition {
  return deepFreeze(AgentDefinitionSchema.parse(def));
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  constructor(defs: readonly AgentDefinition[] = []) {
    for (const d of defs) this.register(d);
  }

  register(def: AgentDefinition): void {
    const parsed = deepFreeze(AgentDefinitionSchema.parse(def));
    if (this.agents.has(parsed.id)) throw new Error(`agent ${parsed.id} already registered`);
    this.agents.set(parsed.id, parsed);
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
