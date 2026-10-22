import { z } from "zod";
import { IdSchema } from "@platform/contracts";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CapabilityIdSchema = z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);

/**
 * A versioned, server-side capability. The model only ever sees capabilities
 * that the runtime selected for a run: agent definition ∩ registered ∩
 * principal policy (requiredGroups) ∩ connector health.
 */
export interface CapabilityDefinition {
  id: string;
  version: string;
  kind: "read" | "write";
  description: string;
  /** Validated server-side on every call, independently of the model provider. */
  input: z.ZodType<Record<string, unknown>>;
  /** Principal must belong to at least one of these groups. */
  requiredGroups: readonly string[];
  timeoutMs: number;
  /** For connector-backed capabilities. */
  connectorId?: string;
}

/** One value read from a live system. Becomes an `lv_` evidence item. */
export interface LiveReadResult {
  resourceId: string;
  title: string;
  /** Structured, bounded, untrusted. */
  data: unknown;
}

/**
 * `principal` is the trusted caller (from TrustedContext, never from model
 * arguments). Personal data sources (calendar, mail) read only this
 * principal's data, as with a delegated token.
 */
export type ReadHandler = (
  input: Record<string, unknown>,
  opts: { signal?: AbortSignal; principal: { customerId: string; principalId: string } },
) => Promise<LiveReadResult[]>;

export interface WriteDescription {
  /** Human-readable operation, shown on the approval card. */
  operation: string;
  destination: string;
  risk: string;
}

/** How an approved write is executed by the ActionService (never by the model). */
export interface WriteBinding {
  connectorId: string;
  tool: string;
  describe(input: Record<string, unknown>): WriteDescription;
  /** Complete connector arguments; bound into the approval hash. */
  toConnectorArgs(input: Record<string, unknown>, meta: { idempotencyKey: string; principalDisplayName: string }): Record<string, unknown>;
  /** Reconciles an uncertain outcome. Returns a receipt if the write is confirmed. */
  reconcile?(read: (tool: string, args: Record<string, unknown>) => Promise<unknown>, connectorArgs: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  receipt(result: unknown): Record<string, unknown>;
}

export interface RegisteredCapability {
  definition: CapabilityDefinition;
  read?: ReadHandler;
  write?: WriteBinding;
  /** Optional health probe (e.g. connector tool pinned and enabled). */
  healthy?: () => Promise<boolean>;
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, RegisteredCapability>();

  register(entry: RegisteredCapability): void {
    const d = entry.definition;
    CapabilityIdSchema.parse(d.id);
    if (this.entries.has(d.id)) throw new Error(`capability ${d.id} already registered`);
    if (d.kind === "write" && !entry.write) throw new Error(`write capability ${d.id} needs a write binding`);
    if (d.kind === "read" && entry.write) throw new Error(`read capability ${d.id} must not have a write binding`);
    this.entries.set(d.id, Object.freeze({ ...entry, definition: Object.freeze({ ...d }) }));
  }

  get(id: string): RegisteredCapability | undefined {
    return this.entries.get(id);
  }

  list(): RegisteredCapability[] {
    return [...this.entries.values()];
  }

  /** Static part of the per-run allowlist (connector health is checked by the runtime). */
  allowedFor(agent: AgentDefinition, principalGroups: readonly string[]): RegisteredCapability[] {
    return agent.capabilities
      .map((id) => this.entries.get(id))
      .filter((e): e is RegisteredCapability => !!e)
      .filter((e) => e.definition.requiredGroups.length === 0 || e.definition.requiredGroups.some((g) => principalGroups.includes(g)));
  }
}

/** Built-in capability: retrieval through the policy-enforcing KnowledgeService. */
export const KNOWLEDGE_SEARCH: CapabilityDefinition = Object.freeze({
  id: "knowledge.search",
  version: "1.0.0",
  kind: "read",
  description:
    "Search authorized, indexed company documents (dated history, decisions, specifications). Returns excerpts with evidence ids, titles, versions and indexing dates.",
  input: z.strictObject({ query: z.string().trim().min(2).max(500) }),
  requiredGroups: [],
  timeoutMs: 30_000,
});

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export const AgentDefinitionSchema = z.strictObject({
  id: IdSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  /** UI display texts per language (e.g. "bg"); the model always gets `instructions`. */
  localized: z.record(z.string().regex(/^[a-z]{2}$/), z.strictObject({ name: z.string().min(1).max(100), description: z.string().max(500) })).optional(),
  instructions: z.string().min(1).max(8000),
  /** Capability ids. Unknown ids are simply unavailable at runtime (fail closed). */
  capabilities: z.array(CapabilityIdSchema).min(1),
  knowledgeScopes: z.strictObject({ sourceIds: z.array(IdSchema).min(1) }),
  outputSchema: z.literal("cited-answer@1"),
  limits: z.strictObject({
    maxToolCalls: z.number().int().min(1).max(10),
    maxEvidence: z.number().int().min(1).max(20),
    minEvidenceScore: z.number().min(0).max(1),
    maxInputChars: z.number().int().min(100).max(8000),
    maxOutputTokens: z.number().int().min(64).max(4096),
    maxOutputChars: z.number().int().min(200).max(20000),
    maxDurationMs: z.number().int().min(1000).max(900000),
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
