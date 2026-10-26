import { GoogleOAuthClient } from "./google.js";
import type { PersonalConnectionStore, StoredConnection } from "./google.js";
import { ConnectorError } from "./types.js";

/**
 * One "Connect" button per integration (ADR 0015). Each provider knows how to
 * send the browser to its own sign-in and consent screen and how to turn the
 * code it returns into tokens; the platform does the rest the same way for
 * every provider (state, browser nonce, sealing, audit).
 *
 * - personal: every user connects their own account (Google Calendar).
 * - organization: one connection for the whole deployment, made by an admin,
 *   because what it brings in is shared with others (Notion pages become
 *   documents readable by NOTION_ACL_GROUPS).
 */
export interface OAuthProvider {
  readonly id: string;
  readonly title: string;
  readonly scope: "personal" | "organization";
  authorizationUrl(req: { state: string; codeChallenge: string }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<StoredConnection>;
  /** Revokes the grant at the provider, if it supports that. */
  revoke(c: StoredConnection): Promise<boolean>;
}

/** Owner key of organization connections. Real principal ids never start with "@". */
export const ORGANIZATION_OWNER = "@organization";
export const connectionOwner = (p: Pick<OAuthProvider, "scope">, principalId: string) => (p.scope === "organization" ? ORGANIZATION_OWNER : principalId);

export class GoogleCalendarProvider implements OAuthProvider {
  readonly id = "google";
  readonly title = "Google Calendar";
  readonly scope = "personal" as const;
  constructor(readonly oauth: GoogleOAuthClient) {}
  authorizationUrl(req: { state: string; codeChallenge: string }) {
    return this.oauth.authorizationUrl(req);
  }
  exchangeCode(code: string, codeVerifier: string) {
    return this.oauth.exchangeCode(code, codeVerifier);
  }
  revoke(c: StoredConnection) {
    return this.oauth.revoke(c.refreshToken ?? c.accessToken);
  }
}

export const NOTION_OAUTH_ENDPOINTS = Object.freeze({
  authorize: "https://api.notion.com/v1/oauth/authorize",
  token: "https://api.notion.com/v1/oauth/token",
});
export type NotionOAuthEndpoints = { [K in keyof typeof NOTION_OAUTH_ENDPOINTS]: string };

/** Notion tokens historically don't expire; when no lifetime is given, treat it as long-lived. */
const LONG_LIVED_MS = 10 * 365 * 86_400_000;

/**
 * Notion public integration OAuth. On Notion's screen the user signs in,
 * picks the workspace and selects exactly the pages the platform may read.
 * The integration's capabilities (set in Notion) should be "Read content"
 * only. Notion doesn't support PKCE; the state and browser nonce still apply.
 */
export class NotionProvider implements OAuthProvider {
  readonly id = "notion";
  readonly title = "Notion";
  readonly scope = "organization" as const;

  constructor(
    private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly endpoints: NotionOAuthEndpoints = NOTION_OAUTH_ENDPOINTS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizationUrl(req: { state: string }) {
    const u = new URL(this.endpoints.authorize);
    u.search = new URLSearchParams({ client_id: this.cfg.clientId, response_type: "code", owner: "user", redirect_uri: this.cfg.redirectUri, state: req.state }).toString();
    return u.toString();
  }

  private async token(body: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoints.token, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
          "content-type": "application/json",
          "notion-version": "2022-06-28",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ConnectorError("unavailable", "Notion sign-in is unreachable", "notion");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const kind = json.error === "invalid_grant" || res.status === 401 ? "denied" : res.status >= 500 ? "unavailable" : "invalid_input";
      throw new ConnectorError(kind, `Notion token request failed: ${String(json.error ?? res.status)}`, "notion");
    }
    return json;
  }

  private toConnection(j: Record<string, unknown>, now: Date, prev?: StoredConnection): StoredConnection {
    return {
      // The workspace name: what an admin needs to see to know what is connected.
      accountEmail: typeof j.workspace_name === "string" ? j.workspace_name.slice(0, 200) : prev?.accountEmail,
      scopes: ["read_content"],
      accessToken: String(j.access_token),
      refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : prev?.refreshToken,
      expiresAt: new Date(now.getTime() + (typeof j.expires_in === "number" ? j.expires_in * 1000 : LONG_LIVED_MS)),
    };
  }

  async exchangeCode(code: string, _codeVerifier?: string, now = new Date()) {
    return this.toConnection(await this.token({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri }), now);
  }

  async refresh(c: StoredConnection, now = new Date()) {
    if (!c.refreshToken) throw new ConnectorError("denied", "Notion access has expired. An admin needs to connect Notion again.", "notion");
    return this.toConnection(await this.token({ grant_type: "refresh_token", refresh_token: c.refreshToken }), now, c);
  }

  /** Notion has no revoke endpoint for public integrations: remove it in Notion → Settings → Connections. */
  async revoke() {
    return false;
  }
}

/**
 * The deployment's Notion token for ingestion: the organization connection,
 * refreshed when needed. `undefined` means "not connected" (the source then
 * lists nothing, so previously indexed pages are removed).
 */
export function notionTokenResolver(store: PersonalConnectionStore, provider: NotionProvider, customerId: string, now: () => Date = () => new Date()) {
  return async (): Promise<string | undefined> => {
    const c = await store.get(customerId, ORGANIZATION_OWNER, "notion");
    if (!c) return undefined;
    if (c.expiresAt.getTime() - 60_000 > now().getTime()) return c.accessToken;
    const fresh = await provider.refresh(c, now());
    await store.save(customerId, ORGANIZATION_OWNER, "notion", { ...fresh, connectedBy: c.connectedBy });
    return fresh.accessToken;
  };
}

export const AIRTABLE_OAUTH_ENDPOINTS = Object.freeze({
  authorize: "https://airtable.com/oauth2/v1/authorize",
  token: "https://airtable.com/oauth2/v1/token",
  api: "https://api.airtable.com",
});
export type AirtableOAuthEndpoints = { [K in keyof typeof AIRTABLE_OAUTH_ENDPOINTS]: string };

/** Read records and the schema of the bases the admin picks; nothing else, no writes. */
export const AIRTABLE_SCOPES = ["data.records:read", "schema.bases:read"] as const;

/** Airtable answers 409 to a refresh token that was just used: someone else refreshed it a moment ago. */
export class RecentlyRefreshedError extends ConnectorError {
  constructor() {
    super("unavailable", "Airtable access was refreshed elsewhere a moment ago", "airtable");
  }
}

/**
 * Airtable OAuth (confidential client). On Airtable's screen the admin signs
 * in and picks which bases (or a whole workspace) the platform may read.
 * PKCE (S256) is required; the client authenticates with HTTP Basic.
 *
 * Access tokens last an hour. Every refresh ROTATES the refresh token and
 * invalidates the previous pair, so refreshes must be serialised and stored
 * atomically: see airtableTokenResolver.
 */
export class AirtableProvider implements OAuthProvider {
  readonly id = "airtable";
  readonly title = "Airtable";
  readonly scope = "organization" as const;

  constructor(
    private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly endpoints: AirtableOAuthEndpoints = AIRTABLE_OAUTH_ENDPOINTS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizationUrl(req: { state: string; codeChallenge: string }) {
    const u = new URL(this.endpoints.authorize);
    u.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: "code",
      scope: AIRTABLE_SCOPES.join(" "),
      state: req.state,
      code_challenge: req.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  }

  private async token(body: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoints.token, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ConnectorError("unavailable", "Airtable sign-in is unreachable", "airtable");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 409) throw new RecentlyRefreshedError();
    if (!res.ok) {
      const kind = json.error === "invalid_grant" || res.status === 401 ? "denied" : res.status >= 500 ? "unavailable" : "invalid_input";
      throw new ConnectorError(kind, `Airtable token request failed: ${String(json.error ?? res.status)}`, "airtable");
    }
    return json;
  }

  private toConnection(j: Record<string, unknown>, now: Date, prev?: StoredConnection): StoredConnection {
    const scopes = typeof j.scope === "string" ? j.scope.split(" ").filter(Boolean) : (prev?.scopes ?? []);
    const missing = AIRTABLE_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) throw new ConnectorError("denied", `Airtable did not grant ${missing.join(", ")}`, "airtable");
    if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string") throw new ConnectorError("unavailable", "Airtable sent no tokens", "airtable");
    return {
      accountEmail: prev?.accountEmail,
      scopes,
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: new Date(now.getTime() + (typeof j.expires_in === "number" ? j.expires_in : 3600) * 1000),
    };
  }

  /** The granted bases' names: what an admin needs to see to know what is connected. Best effort. */
  private async label(accessToken: string): Promise<string | undefined> {
    try {
      const res = await this.fetchImpl(new URL("/v0/meta/bases", this.endpoints.api), { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return undefined;
      const { bases = [], offset } = (await res.json()) as { bases?: { name?: string }[]; offset?: string };
      const names = bases.map((b) => String(b.name ?? "")).filter(Boolean);
      if (!names.length) return undefined;
      const more = names.length - 3;
      return `${names.slice(0, 3).join(", ")}${more > 0 ? ` +${more}` : ""}${offset ? " …" : ""}`.slice(0, 200);
    } catch {
      return undefined;
    }
  }

  async exchangeCode(code: string, codeVerifier: string, now = new Date()) {
    const c = this.toConnection(await this.token({ grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: this.cfg.redirectUri }), now);
    return { ...c, accountEmail: await this.label(c.accessToken) };
  }

  /** Rotates: the returned refresh token replaces the old one, which no longer works. */
  async refresh(c: StoredConnection, now = new Date()) {
    if (!c.refreshToken) throw new ConnectorError("denied", "Airtable access has expired. An admin needs to connect Airtable again.", "airtable");
    return this.toConnection(await this.token({ grant_type: "refresh_token", refresh_token: c.refreshToken }), now, c);
  }

  /** Airtable has no token revocation endpoint: remove the integration in Airtable → Account → Third-party integrations. */
  async revoke() {
    return false;
  }
}

/**
 * The deployment's Airtable token for ingestion: the organization connection,
 * refreshed when needed. `undefined` means "not connected".
 *
 * Refreshing rotates the refresh token, so it happens under the connection's
 * row lock: whoever gets the lock second (the API and the worker, or two
 * workers) re-reads, finds the fresh token and uses it instead of refreshing
 * with a refresh token that no longer works. If Airtable still says "just
 * refreshed" (409: a refresh outside the lock, e.g. a previous process that
 * died before saving), the stored tokens are re-read for a short while
 * rather than failing.
 */
export function airtableTokenResolver(
  store: PersonalConnectionStore,
  provider: AirtableProvider,
  customerId: string,
  opts: { now?: () => Date; retryDelayMs?: number; retries?: number } = {},
) {
  const now = opts.now ?? (() => new Date());
  const fresh = (c: StoredConnection) => c.expiresAt.getTime() - 60_000 > now().getTime();
  return async (): Promise<string | undefined> => {
    const c = await store.get(customerId, ORGANIZATION_OWNER, "airtable");
    if (!c) return undefined;
    if (fresh(c)) return c.accessToken;
    for (let attempt = 0; ; attempt++) {
      const r = await store.update(customerId, ORGANIZATION_OWNER, "airtable", async (cur, save) => {
        if (!cur) return { token: undefined };
        if (fresh(cur)) return { token: cur.accessToken }; // refreshed by whoever held the lock before us
        try {
          const next = await provider.refresh(cur, now());
          await save({ ...next, connectedBy: cur.connectedBy });
          return { token: next.accessToken };
        } catch (err) {
          if (err instanceof RecentlyRefreshedError) return { retry: err };
          throw err;
        }
      });
      if (!("retry" in r)) return r.token;
      if (attempt >= (opts.retries ?? 5)) throw r.retry;
      await new Promise((res) => setTimeout(res, opts.retryDelayMs ?? 2000));
      const again = await store.get(customerId, ORGANIZATION_OWNER, "airtable");
      if (!again) return undefined;
      if (fresh(again)) return again.accessToken;
    }
  };
}
