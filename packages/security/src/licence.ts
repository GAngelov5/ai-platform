import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";

/**
 * Signed licence (ADR 0014). The vendor signs the canonical JSON of `licence`
 * with Ed25519; the platform verifies it against keys compiled into this file.
 *
 * On-premises the customer runs the code, so this is contract enforcement
 * that makes the entitlement explicit and auditable, not DRM.
 */

const Iso = z.iso.datetime({ offset: true });
const EntitlementId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);

export const LicenceSchema = z.strictObject({
  format: z.literal("platform-licence@1"),
  licenceId: z.string().regex(/^lic_[A-Za-z0-9_-]{4,64}$/),
  customerId: z.string().regex(/^[a-z0-9_-]{2,64}$/),
  customerName: z.string().min(1).max(200),
  issuedAt: Iso,
  expiresAt: Iso,
  /** Days after expiry during which add-ons keep working, with a warning. */
  graceDays: z.number().int().min(0).max(90).default(14),
  /** Add-on agents. Core agents are always available. */
  agents: z.array(EntitlementId).max(100),
  workflowKinds: z.array(EntitlementId).max(100),
});
export type Licence = z.infer<typeof LicenceSchema>;

export const SignedLicenceSchema = z.strictObject({
  licence: LicenceSchema,
  keyId: z.string().regex(/^[a-z0-9-]{2,64}$/),
  /** Ed25519 signature over canonicalJson(licence), base64. */
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(200),
});
export type SignedLicence = z.infer<typeof SignedLicenceSchema>;

export interface LicenceKey {
  keyId: string;
  /** Ed25519 public key, SPKI DER, base64. */
  publicKey: string;
  /** Development keys are refused in production. */
  production: boolean;
}

/**
 * Trusted signing keys. The development private key is committed
 * (fixtures/licence/dev-signing-key.pem), so production refuses it. A release
 * adds the vendor's production public key here; its private key never enters
 * this repository (scripts/licence.mjs keygen).
 */
export const TRUSTED_LICENCE_KEYS: readonly LicenceKey[] = Object.freeze([
  { keyId: "dev-2026-10", publicKey: "MCowBQYDK2VwAyEA6fmzaoo9ojLoot/m69UVTTgKZRIdBHiz+DfDgLdkq6A=", production: false },
]);

/** Included in every deployment, licensed or not: customers always keep access to their own knowledge. */
export const CORE_AGENTS: readonly string[] = Object.freeze(["knowledge-assistant"]);

export class LicenceError extends Error {
  readonly code = "invalid_licence";
}

/** Raised when a request needs an add-on the licence doesn't (or no longer) include. */
export class NotLicensedError extends Error {
  readonly code = "not_licensed";
  constructor(readonly entitlement: string) {
    super(`Not included in this deployment's licence: ${entitlement}`);
    this.name = "NotLicensedError";
  }
}

/**
 * Parses and verifies a licence file. Throws LicenceError for anything that
 * is not a genuine licence for this customer: a wrong or tampered file is an
 * installation error, reported at startup. Expiry is not an error here; it is
 * evaluated on every check (see Entitlements).
 */
export function verifyLicence(
  raw: string,
  opts: { customerId: string; production: boolean; keys?: readonly LicenceKey[] },
): Licence {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LicenceError("licence file is not valid JSON");
  }
  const parsed = SignedLicenceSchema.safeParse(json);
  if (!parsed.success) throw new LicenceError(`licence file is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const { licence, keyId, signature } = parsed.data;
  const key = (opts.keys ?? TRUSTED_LICENCE_KEYS).find((k) => k.keyId === keyId);
  if (!key) throw new LicenceError(`licence is signed with an unknown key: ${keyId}`);
  if (opts.production && !key.production) throw new LicenceError(`production refuses the development licence key ${keyId}`);
  // The signature covers the licence exactly as written in the file (before schema defaults).
  const signedBytes = Buffer.from(canonicalJson((json as { licence: unknown }).licence), "utf8");
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
  if (!verify(null, signedBytes, publicKey, Buffer.from(signature, "base64"))) throw new LicenceError("licence signature is invalid");
  if (licence.customerId !== opts.customerId) throw new LicenceError(`licence is for customer ${licence.customerId}, not ${opts.customerId}`);
  if (Date.parse(licence.expiresAt) <= Date.parse(licence.issuedAt)) throw new LicenceError("licence expires before it was issued");
  return licence;
}

export type LicenceStatus = "valid" | "grace" | "expired" | "none";

export interface LicenceSummary {
  status: LicenceStatus;
  licenceId?: string;
  customerName?: string;
  issuedAt?: string;
  expiresAt?: string;
  /** End of the grace period. */
  graceEndsAt?: string;
  /** Whole days until expiry (negative after it). */
  daysLeft?: number;
  agents: string[];
  workflowKinds: string[];
  coreAgents: string[];
}

const DAY = 86_400_000;

/**
 * What this deployment may run, evaluated at the time of each check, so
 * expiry takes effect without a restart. Without a valid licence, or after
 * the grace period, only the core agents remain.
 */
export class Entitlements {
  constructor(
    readonly licence: Licence | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Everything, for tests and tools that don't model licensing. */
  static unrestricted(): Entitlements {
    return new UnrestrictedEntitlements(undefined);
  }

  status(): LicenceStatus {
    const l = this.licence;
    if (!l) return "none";
    const t = this.now().getTime();
    const expires = Date.parse(l.expiresAt);
    if (t < expires) return "valid";
    if (t < expires + l.graceDays * DAY) return "grace";
    return "expired";
  }

  private active(): boolean {
    const s = this.status();
    return s === "valid" || s === "grace";
  }

  agentAllowed(agentId: string): boolean {
    return CORE_AGENTS.includes(agentId) || (this.active() && this.licence!.agents.includes(agentId));
  }

  workflowKindAllowed(kind: string): boolean {
    return this.active() && this.licence!.workflowKinds.includes(kind);
  }

  assertAgent(agentId: string): void {
    if (!this.agentAllowed(agentId)) throw new NotLicensedError(`agent ${agentId}`);
  }

  assertWorkflowKind(kind: string): void {
    if (!this.workflowKindAllowed(kind)) throw new NotLicensedError(`workflow ${kind}`);
  }

  summary(): LicenceSummary {
    const l = this.licence;
    const base = { status: this.status(), coreAgents: [...CORE_AGENTS] };
    if (!l) return { ...base, agents: [], workflowKinds: [] };
    const expires = Date.parse(l.expiresAt);
    return {
      ...base,
      licenceId: l.licenceId,
      customerName: l.customerName,
      issuedAt: l.issuedAt,
      expiresAt: l.expiresAt,
      graceEndsAt: new Date(expires + l.graceDays * DAY).toISOString(),
      daysLeft: Math.floor((expires - this.now().getTime()) / DAY),
      agents: [...l.agents],
      workflowKinds: [...l.workflowKinds],
    };
  }
}

class UnrestrictedEntitlements extends Entitlements {
  override agentAllowed(): boolean {
    return true;
  }
  override workflowKindAllowed(): boolean {
    return true;
  }
}

/**
 * The deployment's entitlements. Production requires LICENCE_FILE (enforced
 * by loadPlatformConfig); elsewhere the committed development licence is the
 * default. A missing or invalid file throws, so startup fails loudly.
 */
export function loadEntitlements(config: { env: string; customerId: string; licenceFile?: string }, defaultFile: string): Entitlements {
  const file = config.licenceFile ?? (config.env === "production" ? undefined : defaultFile);
  if (!file) throw new LicenceError("LICENCE_FILE is required");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new LicenceError(`licence file cannot be read: ${file}`);
  }
  return new Entitlements(verifyLicence(raw, { customerId: config.customerId, production: config.env === "production" }));
}
