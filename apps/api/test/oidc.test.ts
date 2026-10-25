/**
 * Company sign-in (OIDC) end to end: real NestJS app on PGlite, a local fake
 * identity provider that signs real ID tokens (RS256) and checks PKCE and the
 * client secret like a real one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { FakeModelGateway } from "@platform/ai";
import { createRepositories, type Database } from "@platform/database";
import { createTestDatabase } from "@platform/database/testing";
import { loadPlatformConfig } from "@platform/security";
import { seedFixtures } from "@platform/worker/seed";
import { buildDeps, createApiApp, createLogger, type PlatformDeps } from "../src/app.js";
import { principalIdFor } from "../src/auth/oidc.js";

const FIXTURES_ROOT = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const CLIENT = { id: "company-brain", secret: "test-client-secret" };

/** A minimal OpenID provider: discovery, JWKS, and a token endpoint for codes it issued. */
class FakeIdp {
  server!: Server;
  issuer!: string;
  private key!: CryptoKey;
  private jwk!: Record<string, unknown>;
  /** A key the provider does NOT publish, to forge tokens with. */
  forgeKey!: CryptoKey;
  private codes = new Map<string, { challenge: string; redirectUri: string; nonce: string; claims: Record<string, unknown>; forge?: boolean; nonceOverride?: string }>();

  async start() {
    const pair = await generateKeyPair("RS256");
    this.key = pair.privateKey;
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    this.forgeKey = (await generateKeyPair("RS256")).privateKey;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/realms/company`;
    return this;
  }
  close() {
    this.server?.close();
  }

  /** What the provider's login page does: the user signs in; returns the code for the redirect. */
  consent(authorizeUrl: string, claims: Record<string, unknown>, o: { forge?: boolean; nonceOverride?: string } = {}) {
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("client_id")).toBe(CLIENT.id);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const code = randomBytes(12).toString("hex");
    this.codes.set(code, { challenge: u.searchParams.get("code_challenge")!, redirectUri: u.searchParams.get("redirect_uri")!, nonce: u.searchParams.get("nonce")!, claims, ...o });
    return { code, state: u.searchParams.get("state")! };
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", this.issuer);
    const json = (s: number, b: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b));
    const path = url.pathname.replace(new URL(this.issuer).pathname, "");
    if (path === "/.well-known/openid-configuration")
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${this.issuer}/protocol/openid-connect/token`,
        jwks_uri: `${this.issuer}/protocol/openid-connect/certs`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    if (path === "/protocol/openid-connect/certs") return json(200, { keys: [this.jwk] });
    if (path === "/protocol/openid-connect/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const basic = (req.headers.authorization ?? "").replace(/^Basic /, "");
      const [bid, bsecret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [form.get("client_id"), form.get("client_secret")];
      if (bid !== CLIENT.id || bsecret !== CLIENT.secret) return json(401, { error: "invalid_client" });
      const c = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!c || c.redirectUri !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
      const idToken = await new SignJWT({ ...c.claims, nonce: c.nonceOverride ?? c.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(this.issuer)
        .setAudience(CLIENT.id)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(c.forge ? this.forgeKey : this.key);
      return json(200, { access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    json(404, {});
  }
}

let idp: FakeIdp;
let db: Database;
let close: () => Promise<void>;
let app: INestApplication;
let base: string;
let deps: PlatformDeps;

class Browser {
  cookies = new Map<string, string>();
  async get(path: string) {
    const res = await fetch(base + path, { redirect: "manual", headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      const v = kv!.slice(i + 1);
      if (v === "" || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(kv!.slice(0, i));
      else this.cookies.set(kv!.slice(0, i), v);
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get("location"), json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
  }
  /** The whole sign-in: platform → provider (user signs in) → platform. */
  async signIn(claims: Record<string, unknown>, o: { forge?: boolean; nonceOverride?: string } = {}) {
    const start = await this.get("/api/auth/oidc/login");
    expect(start.status).toBe(302);
    const { code, state } = idp.consent(start.location!, claims, o);
    return this.get(`/api/auth/oidc/callback?code=${code}&state=${state}`);
  }
}

const alice = { sub: "f2c1a0de-0000-4000-8000-000000000001", name: "Alice Example", email: "Alice@Company.test", email_verified: true, groups: ["/Staff", "/Atlas Team"] };

beforeAll(async () => {
  idp = await new FakeIdp().start();
  ({ db, close } = await createTestDatabase());
  await seedFixtures(db, FIXTURES_ROOT, "cust_demo");
  const config = loadPlatformConfig({
    APP_ENV: "test",
    LOG_LEVEL: "fatal",
    AUTH_MODE: "oidc",
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: CLIENT.id,
    OIDC_CLIENT_SECRET: CLIENT.secret,
    OIDC_GROUP_MAP: JSON.stringify({ Staff: "all-staff", "Atlas Team": "atlas-team" }),
    OIDC_ADMIN_GROUPS: "Platform Admins",
    PUBLIC_ORIGIN: "https://brain.example.test",
  });
  deps = await buildDeps({ config, db, logger: createLogger("fatal"), pingDatabase: async () => {}, model: new FakeModelGateway() });
  app = await createApiApp(deps);
  await app.listen(0, "127.0.0.1");
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
  await deps?.connectors.closeAll();
  idp?.close();
  await close?.();
});

describe("company sign-in (OIDC)", () => {
  it("sends the browser to the provider with PKCE, state and a nonce bound to the browser", async () => {
    const b = new Browser();
    const r = await b.get("/api/auth/oidc/login");
    const u = new URL(r.location!);
    expect(u.origin + u.pathname).toBe(`${idp.issuer}/protocol/openid-connect/auth`);
    expect(u.searchParams.get("redirect_uri")).toBe("https://brain.example.test/api/auth/oidc/callback");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("nonce")).toBeTruthy();
    expect(b.cookies.has("platform_login_nonce")).toBe(true);
    expect((await b.get("/api/config/public")).json).toMatchObject({ authMode: "oidc" });
  });

  it("signs in: creates the user from the ID token, maps directory groups, and opens a session", async () => {
    const b = new Browser();
    const r = await b.signIn(alice);
    expect(r.location).toBe("/chat");
    const me = (await b.get("/api/auth/me")).json;
    expect(me).toMatchObject({ principalId: principalIdFor(alice.sub), displayName: "Alice Example", authMode: "oidc", roles: ["user"] });
    const p = await createRepositories(db).principals.get("cust_demo", me.principalId);
    expect(p).toMatchObject({ origin: "oidc", email: "alice@company.test", groups: ["all-staff", "atlas-team"] });
  });

  it("permissions follow the mapped groups (Atlas documents for the Atlas team only)", async () => {
    const atlas = new Browser();
    await atlas.signIn(alice);
    const staff = new Browser();
    await staff.signIn({ sub: "sub-staff-only", name: "Sam Staff", email: "sam@company.test", groups: ["/Staff", "/Some Unmapped Group"] });
    const conv = async (b: Browser) => {
      const csrf = (await b.get("/api/auth/csrf")).json.token as string;
      const post = (path: string, body: unknown) =>
        fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
      const c = await post("/api/conversations", { agentId: "knowledge-assistant" });
      return (await post(`/api/conversations/${c.id}/messages`, { content: "Why was Project Atlas delayed?" })).assistantMessage;
    };
    expect((await conv(atlas)).status).toBe("answered");
    const denied = await conv(staff);
    expect(denied.status).toBe("insufficient_evidence");
    expect(JSON.stringify(denied)).not.toContain("Northwind");
  });

  it("gives the admin role through a directory group, and refreshes groups on every sign-in", async () => {
    const b = new Browser();
    await b.signIn({ ...alice, sub: "sub-dana", name: "Dana Admin", groups: ["/Staff", "/Platform Admins"] });
    expect((await b.get("/api/auth/me")).json.roles).toEqual(["user", "admin"]);
    const again = new Browser();
    await again.signIn({ ...alice, sub: "sub-dana", name: "Dana Admin", groups: ["/Staff"] });
    expect((await again.get("/api/auth/me")).json.roles).toEqual(["user"]);
    expect((await createRepositories(db).principals.get("cust_demo", principalIdFor("sub-dana")))?.groups).toEqual(["all-staff"]);
  });

  it("rejects a callback from another browser, a replayed state, a forged token and a wrong nonce", async () => {
    const b = new Browser();
    const start = await b.get("/api/auth/oidc/login");
    const { code, state } = idp.consent(start.location!, alice);
    const other = new Browser(); // no nonce cookie: not the browser that started
    expect((await other.get(`/api/auth/oidc/callback?code=${code}&state=${state}`)).location).toBe("/?login=error");
    expect((await b.get(`/api/auth/oidc/callback?code=${code}&state=${state}`)).location).toBe("/?login=error"); // state already used
    expect((await new Browser().signIn(alice, { forge: true })).location).toBe("/?login=error");
    expect((await new Browser().signIn(alice, { nonceOverride: "someone-elses-nonce" })).location).toBe("/?login=error");
    expect((await new Browser().get("/api/auth/oidc/callback?state=made-up&code=x")).location).toBe("/?login=error");
  });

  it("reports a cancelled sign-in, refuses disabled users, and keeps development sign-in off", async () => {
    const b = new Browser();
    const start = await b.get("/api/auth/oidc/login");
    const state = new URL(start.location!).searchParams.get("state")!;
    expect((await b.get(`/api/auth/oidc/callback?error=access_denied&state=${state}`)).location).toBe("/?login=cancelled");

    // Someone who left: disabled in the platform, still able to sign in at the provider.
    const leaver = new Browser();
    await leaver.signIn({ ...alice, sub: "sub-leaver" });
    await createRepositories(db).principals.setDisabled("cust_demo", principalIdFor("sub-leaver"), true);
    expect((await leaver.get("/api/auth/me")).status).toBe(401); // the existing session stops working at once
    expect((await new Browser().signIn({ ...alice, sub: "sub-leaver" })).location).toBe("/?login=error");

    expect((await new Browser().get("/api/auth/dev-principals")).status).toBe(404);
  });
});
