import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SecretSealer } from "@platform/security";
import { AirtableProvider, airtableTokenResolver, connectionOwner, newAuthorizationRequest, ORGANIZATION_OWNER, PersonalConnectionStore } from "../src/index.js";
import { FakeAirtableOAuth, memoryConnectionRows } from "../src/testing.js";

const C = "cust_demo";
const REDIRECT = "https://brain.example.test/api/connections/airtable/callback";
let airtable: FakeAirtableOAuth;
beforeAll(async () => {
  airtable = await new FakeAirtableOAuth().start();
});
afterAll(() => airtable.close());
beforeEach(() => {
  airtable.refreshDelayMs = 0;
  airtable.refreshCalls.length = 0;
});

const provider = (secret = "airtable-secret") => new AirtableProvider({ clientId: "airtable-client", clientSecret: secret, redirectUri: REDIRECT }, airtable.endpoints);
const key = randomBytes(32).toString("base64");
const storeOn = (rows: ReturnType<typeof memoryConnectionRows>) => new PersonalConnectionStore(rows, new SecretSealer(key));
/** A clock past the access token's hour, so the next use must refresh. */
const later = () => new Date(Date.now() + 2 * 3600_000);

async function connect(p = provider()) {
  const auth = newAuthorizationRequest();
  const code = airtable.consent(p.authorizationUrl(auth));
  return { code, auth, c: await p.exchangeCode(code, auth.codeVerifier) };
}

describe("Airtable OAuth provider", () => {
  it("sends the admin to Airtable's own sign-in and base picker, with PKCE and read-only scopes", () => {
    const auth = newAuthorizationRequest();
    const u = new URL(provider().authorizationUrl(auth));
    expect(u.origin + u.pathname).toBe(airtable.endpoints.authorize);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "airtable-client",
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "data.records:read schema.bases:read",
      state: auth.state,
      code_challenge: auth.codeChallenge,
      code_challenge_method: "S256",
    });
    // Airtable accepts a state of 16 to 1024 characters.
    expect(auth.state.length).toBeGreaterThanOrEqual(16);
  });

  it("is an organization connection", () => {
    expect(provider().scope).toBe("organization");
    expect(connectionOwner(provider(), "dana")).toBe(ORGANIZATION_OWNER);
  });

  it("exchanges the code once, with Basic client credentials and the PKCE verifier, and labels the connection with the granted bases", async () => {
    const { c, code, auth } = await connect();
    expect(c).toMatchObject({ accountEmail: "Sales CRM", scopes: ["data.records:read", "schema.bases:read"] });
    expect(c.refreshToken).toMatch(/^atrt-/);
    expect(c.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3600_000);
    await expect(provider().exchangeCode(code, auth.codeVerifier)).rejects.toMatchObject({ kind: "denied" }); // single use
    const other = newAuthorizationRequest();
    await expect(provider().exchangeCode(airtable.consent(provider().authorizationUrl(other)), auth.codeVerifier)).rejects.toMatchObject({ kind: "denied" }); // wrong verifier
    await expect(provider("nope").exchangeCode(airtable.consent(provider().authorizationUrl(other)), other.codeVerifier)).rejects.toMatchObject({ kind: "denied" });
  });

  it("refuses a grant without the scopes it needs", async () => {
    const auth = newAuthorizationRequest();
    const code = airtable.consent(provider().authorizationUrl(auth), { scope: "data.records:read" });
    await expect(provider().exchangeCode(code, auth.codeVerifier)).rejects.toMatchObject({ kind: "denied", message: expect.stringContaining("schema.bases:read") });
  });

  it("each refresh rotates the refresh token; the old pair stops working", async () => {
    const { c } = await connect();
    const next = await provider().refresh(c);
    expect(next.refreshToken).not.toBe(c.refreshToken);
    expect(airtable.accessTokenWorks(c.accessToken)).toBe(false);
    expect(airtable.accessTokenWorks(next.accessToken)).toBe(true);
    // The old refresh token again, right away: Airtable says "recently refreshed" (409).
    await expect(provider().refresh(c)).rejects.toMatchObject({ name: "ConnectorError", kind: "unavailable", message: expect.stringContaining("refreshed elsewhere") });
  });
});

describe("Airtable ingestion token", () => {
  it("is undefined when not connected, the stored token while fresh, and a refreshed one (saved, keeping who connected) after an hour", async () => {
    const rows = memoryConnectionRows();
    const s = storeOn(rows);
    expect(await airtableTokenResolver(s, provider(), C)()).toBeUndefined();
    const { c } = await connect();
    await s.save(C, ORGANIZATION_OWNER, "airtable", { ...c, connectedBy: "dana" });
    expect(await airtableTokenResolver(s, provider(), C)()).toBe(c.accessToken);
    expect(airtable.refreshCalls).toEqual([]);
    const fresh = await airtableTokenResolver(s, provider(), C, { now: later })();
    expect(fresh).not.toBe(c.accessToken);
    expect(airtable.accessTokenWorks(fresh!)).toBe(true);
    expect(await s.get(C, ORGANIZATION_OWNER, "airtable")).toMatchObject({ accessToken: fresh, connectedBy: "dana", accountEmail: "Sales CRM" });
  });

  it("the API and the worker refreshing at once: one refresh, both get the new token, the connection keeps working", async () => {
    const rows = memoryConnectionRows();
    const { c } = await connect();
    await storeOn(rows).save(C, ORGANIZATION_OWNER, "airtable", { ...c, connectedBy: "dana" });
    airtable.refreshDelayMs = 50;
    // Two processes: separate stores (no shared in-process lock), the same rows (the database).
    const api = airtableTokenResolver(storeOn(rows), provider(), C, { now: later });
    const worker = airtableTokenResolver(storeOn(rows), provider(), C, { now: later });
    const [a, b] = await Promise.all([api(), worker()]);
    expect(airtable.refreshCalls).toEqual([c.refreshToken]);
    expect(a).toBe(b);
    expect(airtable.accessTokenWorks(a!)).toBe(true);
    const stored = await storeOn(rows).get(C, ORGANIZATION_OWNER, "airtable");
    expect(stored?.accessToken).toBe(a);
    // And the stored refresh token is the rotated one, which still refreshes.
    expect(await provider().refresh(stored!)).toMatchObject({ accessToken: expect.stringMatching(/^atat-/) });
  });

  it("on a 409 (refreshed outside the lock a moment ago), re-reads the stored tokens instead of failing", async () => {
    const rows = memoryConnectionRows();
    const s = storeOn(rows);
    const { c } = await connect();
    await s.save(C, ORGANIZATION_OWNER, "airtable", { ...c, expiresAt: new Date(0), connectedBy: "dana" });
    // Another process refreshed with the same refresh token and saves the new pair a moment later.
    const elsewhere = await provider().refresh(c);
    setTimeout(() => void s.save(C, ORGANIZATION_OWNER, "airtable", { ...elsewhere, connectedBy: "dana" }), 30);
    expect(await airtableTokenResolver(s, provider(), C, { retryDelayMs: 20 })()).toBe(elsewhere.accessToken);
    // Ours was answered 409 (maybe more than once while waiting), never retried with anything else.
    expect(airtable.refreshCalls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(airtable.refreshCalls)).toEqual(new Set([c.refreshToken]));
  });

  it("gives up with a clear error when the stored tokens never catch up after a 409", async () => {
    const rows = memoryConnectionRows();
    const s = storeOn(rows);
    const { c } = await connect();
    await provider().refresh(c); // rotated elsewhere, never saved here
    await s.save(C, ORGANIZATION_OWNER, "airtable", { ...c, expiresAt: new Date(0) });
    await expect(airtableTokenResolver(s, provider(), C, { retryDelayMs: 5, retries: 2 })()).rejects.toMatchObject({ kind: "unavailable" });
  });
});
