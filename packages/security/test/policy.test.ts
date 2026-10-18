import { describe, expect, it } from "vitest";
import { canReadDocument, createTrustedContext, isLocalHostname, type Principal } from "../src/index.js";

const alice: Principal = { id: "alice", customerId: "c1", displayName: "A", groups: ["atlas-team"], roles: [], disabled: false };
const doc = { customerId: "c1", sourceId: "s1", aclGroups: ["atlas-team"], tombstoned: false };

describe("document access policy", () => {
  it("allows only on group intersection within the same customer", () => {
    expect(canReadDocument(alice, doc)).toBe(true);
    expect(canReadDocument(alice, { ...doc, aclGroups: ["finance-legal"] })).toBe(false);
    expect(canReadDocument(alice, { ...doc, customerId: "c2" })).toBe(false);
  });

  it("fails closed for empty ACLs, tombstones, disabled principals and out-of-scope sources", () => {
    expect(canReadDocument(alice, { ...doc, aclGroups: [] })).toBe(false);
    expect(canReadDocument(alice, { ...doc, tombstoned: true })).toBe(false);
    expect(canReadDocument({ ...alice, disabled: true }, doc)).toBe(false);
    expect(canReadDocument(alice, doc, ["other-source"])).toBe(false);
  });

  it("creates frozen trusted contexts", () => {
    const ctx = createTrustedContext({ customerId: "c1", principalId: "alice", policyVersion: "p1" });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it("classifies local hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.4", "vllm", "[::1]"]) expect(isLocalHostname(h)).toBe(true);
    for (const h of ["api.openai.com", "8.8.8.8", "172.32.0.1", "example.com"]) expect(isLocalHostname(h)).toBe(false);
  });
});
