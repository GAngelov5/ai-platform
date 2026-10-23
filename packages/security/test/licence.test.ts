import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson, CORE_AGENTS, Entitlements, LicenceError, loadEntitlements, NotLicensedError, verifyLicence, type LicenceKey } from "../src/index.js";

const DIR = fileURLToPath(new URL("../../../fixtures/licence/", import.meta.url));
const devFile = readFileSync(`${DIR}dev.licence.json`, "utf8");
const dev = { customerId: "cust_demo", production: false };

const body = {
  format: "platform-licence@1",
  licenceId: "lic_test_1",
  customerId: "cust_demo",
  customerName: "Test",
  issuedAt: "2026-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:00:00Z",
  graceDays: 14,
  agents: ["project-assistant"],
  workflowKinds: ["tracker-status-check"],
};

/** A throwaway key pair, so tests can sign arbitrary licences. */
function signer(production: boolean) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key: LicenceKey = { keyId: production ? "prod-test" : "dev-test", publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), production };
  const signFile = (licence: unknown) => JSON.stringify({ licence, keyId: key.keyId, signature: sign(null, Buffer.from(canonicalJson(licence)), privateKey).toString("base64") });
  return { key, signFile };
}

const at = (iso: string) => () => new Date(iso);

describe("licence verification", () => {
  it("accepts the committed development licence, signed by scripts/licence.mjs", () => {
    const l = verifyLicence(devFile, dev);
    expect(l).toMatchObject({ licenceId: "lic_dev_demo", agents: ["project-assistant", "meeting-prep"], workflowKinds: ["tracker-status-check"] });
  });

  it("rejects a tampered licence (an added agent breaks the signature)", () => {
    const f = JSON.parse(devFile);
    f.licence.agents.push("contract-review");
    expect(() => verifyLicence(JSON.stringify(f), dev)).toThrow(/signature is invalid/);
  });

  it("rejects an extended expiry, a key swap and an unknown key", () => {
    const f = JSON.parse(devFile);
    expect(() => verifyLicence(JSON.stringify({ ...f, licence: { ...f.licence, expiresAt: "2099-01-01T00:00:00Z" } }), dev)).toThrow(/signature/);
    const own = signer(false);
    // Signed by someone else's key but claiming the trusted key id.
    const forged = JSON.parse(own.signFile(body));
    expect(() => verifyLicence(JSON.stringify({ ...forged, keyId: "dev-2026-10" }), dev)).toThrow(/signature/);
    expect(() => verifyLicence(own.signFile(body), dev)).toThrow(/unknown key/);
  });

  it("refuses the development key in production", () => {
    expect(() => verifyLicence(devFile, { customerId: "cust_demo", production: true })).toThrow(/production refuses the development licence key/);
    const prod = signer(true);
    expect(verifyLicence(prod.signFile(body), { customerId: "cust_demo", production: true, keys: [prod.key] }).licenceId).toBe("lic_test_1");
  });

  it("rejects a licence for another customer, malformed files and impossible dates", () => {
    expect(() => verifyLicence(devFile, { customerId: "cust_other", production: false })).toThrow(/for customer cust_demo/);
    expect(() => verifyLicence("{", dev)).toThrow(LicenceError);
    expect(() => verifyLicence(JSON.stringify({ licence: {}, keyId: "x", signature: "AA==" }), dev)).toThrow(/malformed/);
    const s = signer(false);
    expect(() => verifyLicence(s.signFile({ ...body, expiresAt: body.issuedAt }), { ...dev, keys: [s.key] })).toThrow(/expires before/);
    expect(() => verifyLicence(s.signFile({ ...body, extra: true }), { ...dev, keys: [s.key] })).toThrow(/malformed/);
  });

  it("loads the development licence by default outside production, and requires a file in production", () => {
    expect(loadEntitlements({ env: "test", customerId: "cust_demo" }, `${DIR}dev.licence.json`).status()).toBe("valid");
    expect(() => loadEntitlements({ env: "production", customerId: "cust_demo" }, `${DIR}dev.licence.json`)).toThrow(/LICENCE_FILE is required/);
    expect(() => loadEntitlements({ env: "test", customerId: "cust_demo", licenceFile: `${DIR}missing.json` }, "")).toThrow(/cannot be read/);
  });
});

describe("entitlements", () => {
  const licence = verifyLicence(devFile, dev);

  it("allows licensed add-ons and core agents, nothing else", () => {
    const e = new Entitlements(licence, at("2027-01-01T00:00:00Z"));
    expect(e.agentAllowed("project-assistant")).toBe(true);
    expect(e.agentAllowed("knowledge-assistant")).toBe(true);
    expect(e.agentAllowed("contract-review")).toBe(false);
    expect(e.workflowKindAllowed("tracker-status-check")).toBe(true);
    expect(() => e.assertAgent("contract-review")).toThrow(NotLicensedError);
  });

  it("keeps add-ons during the grace period, then falls back to core only", () => {
    const s = signer(false);
    const l = verifyLicence(s.signFile(body), { ...dev, keys: [s.key] });
    const valid = new Entitlements(l, at("2026-12-31T23:59:59Z"));
    const grace = new Entitlements(l, at("2027-01-10T00:00:00Z"));
    const expired = new Entitlements(l, at("2027-01-15T00:00:01Z"));
    expect([valid.status(), grace.status(), expired.status()]).toEqual(["valid", "grace", "expired"]);
    expect(grace.agentAllowed("project-assistant")).toBe(true);
    expect(grace.summary()).toMatchObject({ daysLeft: -9, graceEndsAt: "2027-01-15T00:00:00.000Z" });
    expect(expired.agentAllowed("project-assistant")).toBe(false);
    expect(expired.workflowKindAllowed("tracker-status-check")).toBe(false);
    // Customers never lose access to their own knowledge.
    for (const id of CORE_AGENTS) expect(expired.agentAllowed(id)).toBe(true);
  });

  it("without a licence only core agents are allowed; unrestricted allows everything", () => {
    const none = new Entitlements(undefined);
    expect(none.status()).toBe("none");
    expect(none.agentAllowed("knowledge-assistant")).toBe(true);
    expect(none.agentAllowed("project-assistant")).toBe(false);
    expect(none.summary()).toEqual({ status: "none", coreAgents: ["knowledge-assistant"], agents: [], workflowKinds: [] });
    expect(Entitlements.unrestricted().workflowKindAllowed("anything")).toBe(true);
  });

  it("the committed core-only and expired fixtures behave as documented", () => {
    const core = loadEntitlements({ env: "test", customerId: "cust_demo", licenceFile: `${DIR}dev-core-only.licence.json` }, "");
    expect(core.agentAllowed("project-assistant")).toBe(false);
    expect(core.status()).toBe("valid");
    const expired = loadEntitlements({ env: "test", customerId: "cust_demo", licenceFile: `${DIR}dev-expired.licence.json` }, "");
    expect(expired.status()).toBe("expired");
    expect(expired.agentAllowed("meeting-prep")).toBe(false);
  });
});
