import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import type { GoogleEndpoints, SealedConnectionRows } from "./google.js";

/**
 * A local fake of Google's OAuth and Calendar endpoints, for tests only. It
 * checks what real Google checks that matters here: client credentials,
 * PKCE (S256), redirect URI, single-use codes, bearer tokens.
 */
export class FakeGoogle {
  server!: Server;
  endpoints!: GoogleEndpoints;
  readonly revoked: string[] = [];
  readonly calendarRequests: { token: string; query: URLSearchParams }[] = [];
  /** code -> what the consent screen produced. */
  private readonly codes = new Map<string, { challenge: string; redirectUri: string; email: string; scope: string }>();
  private readonly access = new Map<string, string>(); // access token -> email
  private readonly refresh = new Map<string, string>(); // refresh token -> email
  private n = 0;
  events: Record<string, unknown[]> = {};

  constructor(private readonly client = { id: "test-client", secret: "test-secret" }) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.endpoints = { authorize: `${base}/o/oauth2/v2/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: base };
    return this;
  }

  close() {
    this.server?.close();
  }

  /** What Google does after the user consents: returns the code it would put on the redirect. */
  consent(authorizationUrl: string, opts: { email: string; scope?: string }): string {
    const u = new URL(authorizationUrl);
    const code = `code-${++this.n}`;
    this.codes.set(code, {
      challenge: u.searchParams.get("code_challenge") ?? "",
      redirectUri: u.searchParams.get("redirect_uri") ?? "",
      email: opts.email,
      scope: opts.scope ?? u.searchParams.get("scope") ?? "",
    });
    return code;
  }

  /** Simulates the access token expiring or being revoked at Google. */
  invalidateAccessTokens() {
    this.access.clear();
  }
  revokeAll() {
    this.access.clear();
    this.refresh.clear();
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (req.method === "POST" && url.pathname === "/token") {
      if (form.get("client_id") !== this.client.id || form.get("client_secret") !== this.client.secret) return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const c = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!c || c.redirectUri !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
        const at = `at-${++this.n}`;
        const rt = `rt-${++this.n}`;
        this.access.set(at, c.email);
        this.refresh.set(rt, c.email);
        const idToken = ["e30", Buffer.from(JSON.stringify({ email: c.email })).toString("base64url"), "sig"].join(".");
        return json(200, { access_token: at, refresh_token: rt, expires_in: 3599, scope: c.scope, token_type: "Bearer", id_token: idToken });
      }
      if (form.get("grant_type") === "refresh_token") {
        const email = this.refresh.get(form.get("refresh_token") ?? "");
        if (!email) return json(400, { error: "invalid_grant" });
        const at = `at-${++this.n}`;
        this.access.set(at, email);
        return json(200, { access_token: at, expires_in: 3599, token_type: "Bearer" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      const t = form.get("token") ?? "";
      this.revoked.push(t);
      this.refresh.delete(t);
      this.access.delete(t);
      return json(200, {});
    }
    if (req.method === "GET" && url.pathname === "/calendar/v3/calendars/primary/events") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const email = this.access.get(token);
      if (!email) return json(401, { error: { code: 401 } });
      this.calendarRequests.push({ token, query: url.searchParams });
      return json(200, { items: this.events[email] ?? [] });
    }
    json(404, {});
  }
}

/** In-memory SealedConnectionRows (the database package implements the real one). */
export function memoryConnectionRows(): SealedConnectionRows & { rows: Map<string, Parameters<SealedConnectionRows["upsert"]>[0] & { createdAt: Date }> } {
  const rows = new Map<string, Parameters<SealedConnectionRows["upsert"]>[0] & { createdAt: Date }>();
  const key = (c: string, p: string, v: string) => `${c}|${p}|${v}`;
  return {
    rows,
    async get(c, p, v) {
      return rows.get(key(c, p, v));
    },
    async upsert(r) {
      const prev = rows.get(key(r.customerId, r.principalId, r.provider));
      rows.set(key(r.customerId, r.principalId, r.provider), { ...r, refreshTokenSealed: r.refreshTokenSealed ?? prev?.refreshTokenSealed ?? null, createdAt: prev?.createdAt ?? new Date() });
    },
    async delete(c, p, v) {
      return rows.delete(key(c, p, v));
    },
  };
}

/** A local fake of Notion's OAuth endpoints (public integration), for tests only. */
export class FakeNotionOAuth {
  server!: Server;
  endpoints!: { authorize: string; token: string };
  private readonly codes = new Map<string, { redirectUri: string; workspace: string }>();
  readonly refreshTokens = new Set<string>();
  /** Lifetime to report for new tokens; undefined = no expiry (Notion's classic behaviour). */
  expiresIn: number | undefined;
  private n = 0;

  constructor(private readonly client = { id: "notion-client", secret: "notion-secret" }) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.endpoints = { authorize: `${base}/v1/oauth/authorize`, token: `${base}/v1/oauth/token` };
    return this;
  }

  close() {
    this.server?.close();
  }

  /** What Notion does after the user signs in and picks pages: the code for the redirect. */
  consent(authorizationUrl: string, opts: { workspace: string }): string {
    const u = new URL(authorizationUrl);
    const code = `ncode-${++this.n}`;
    this.codes.set(code, { redirectUri: u.searchParams.get("redirect_uri") ?? "", workspace: opts.workspace });
    return code;
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method !== "POST" || req.url !== "/v1/oauth/token") return json(404, {});
    const basic = `Basic ${Buffer.from(`${this.client.id}:${this.client.secret}`).toString("base64")}`;
    if (req.headers.authorization !== basic) return json(401, { error: "invalid_client" });
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, string>;
    const issue = (workspace: string) => {
      const rt = `nrt-${++this.n}`;
      this.refreshTokens.add(rt);
      return json(200, {
        access_token: `ntn-at-${++this.n}`,
        token_type: "bearer",
        bot_id: "bot-1",
        workspace_id: "ws-1",
        workspace_name: workspace,
        refresh_token: rt,
        ...(this.expiresIn ? { expires_in: this.expiresIn } : {}),
      });
    };
    if (body.grant_type === "authorization_code") {
      const c = this.codes.get(body.code ?? "");
      this.codes.delete(body.code ?? "");
      if (!c || c.redirectUri !== body.redirect_uri) return json(400, { error: "invalid_grant" });
      return issue(c.workspace);
    }
    if (body.grant_type === "refresh_token") {
      if (!this.refreshTokens.delete(body.refresh_token ?? "")) return json(400, { error: "invalid_grant" });
      return issue("Refreshed workspace");
    }
    return json(400, { error: "unsupported_grant_type" });
  }
}
