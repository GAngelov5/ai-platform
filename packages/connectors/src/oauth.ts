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
