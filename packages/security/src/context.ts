import { randomUUID } from "node:crypto";

declare const trustedBrand: unique symbol;

/**
 * Identity and policy context for one server-side request.
 *
 * Construct only after server-side authentication (see the API auth guard).
 * The brand prevents structurally similar objects, for example parsed client
 * input or model tool arguments, from being passed where a TrustedContext is
 * required. Types alone do not establish trust: execution paths still reload
 * principals and policy from storage.
 */
export type TrustedContext = Readonly<{
  customerId: string;
  principalId: string;
  requestId: string;
  policyVersion: string;
}> & { readonly [trustedBrand]: true };

export interface AuthenticatedSessionFacts {
  customerId: string;
  principalId: string;
  policyVersion: string;
  /** Server-generated correlation ID (never taken from client headers). */
  requestId?: string;
}

export function createTrustedContext(facts: AuthenticatedSessionFacts): TrustedContext {
  return Object.freeze({
    customerId: facts.customerId,
    principalId: facts.principalId,
    requestId: facts.requestId ?? randomUUID(),
    policyVersion: facts.policyVersion,
  }) as TrustedContext;
}
