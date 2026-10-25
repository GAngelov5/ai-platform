import { createHash, randomBytes } from "node:crypto";
import type { SecretSealer } from "@platform/security";
import { ConnectorError, type Connector, type ConnectorCallOptions, type ConnectorResult, type ConnectorToolStatus } from "./types.js";

/**
 * Personal Google connections (ADR 0015). Each user connects their own
 * account; the platform holds a read-only calendar token for that user only.
 * Endpoints are fixed in code (no configurable URL, so no SSRF); tests inject
 * a local fake.
 */
export const GOOGLE_ENDPOINTS = Object.freeze({
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  api: "https://www.googleapis.com",
});
export type GoogleEndpoints = { [K in keyof typeof GOOGLE_ENDPOINTS]: string };

/** The narrowest scope that lists events: read-only, no calendar settings, no writes. */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_SCOPES = ["openid", "email", GOOGLE_CALENDAR_SCOPE] as const;

export interface StoredConnection {
  /** Account shown to the user: the Google address, or the Notion workspace name. */
  accountEmail?: string;
  /** Who made the connection (for organization connections, the admin). */
  connectedBy?: string;
  scopes: string[];
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

/** Rows as stored: tokens already sealed. Implemented by the database package. */
export interface SealedConnectionRows {
  get(customerId: string, principalId: string, provider: string): Promise<
    | {
        accountEmail: string | null;
        connectedBy: string | null;
        scopes: string[];
        accessTokenSealed: string;
        refreshTokenSealed: string | null;
        accessTokenExpiresAt: Date;
        createdAt: Date;
      }
    | undefined
  >;
  upsert(row: {
    customerId: string;
    principalId: string;
    provider: string;
    accountEmail: string | null;
    connectedBy: string | null;
    scopes: string[];
    accessTokenSealed: string;
    refreshTokenSealed: string | null;
    accessTokenExpiresAt: Date;
  }): Promise<void>;
  delete(customerId: string, principalId: string, provider: string): Promise<boolean>;
}

/** Seals tokens on the way in, opens them on the way out. The sealing context binds a token to its owner. */
export class PersonalConnectionStore {
  constructor(
    private readonly rows: SealedConnectionRows,
    private readonly sealer: SecretSealer,
  ) {}

  private static context(customerId: string, principalId: string, provider: string, which: string) {
    return `${provider}:${which}:${customerId}:${principalId}`;
  }

  async get(customerId: string, principalId: string, provider: string): Promise<(StoredConnection & { connectedAt: Date }) | undefined> {
    const r = await this.rows.get(customerId, principalId, provider);
    if (!r) return undefined;
    const ctx = (w: string) => PersonalConnectionStore.context(customerId, principalId, provider, w);
    return {
      accountEmail: r.accountEmail ?? undefined,
      connectedBy: r.connectedBy ?? undefined,
      scopes: r.scopes,
      accessToken: this.sealer.open(r.accessTokenSealed, ctx("access")),
      refreshToken: r.refreshTokenSealed ? this.sealer.open(r.refreshTokenSealed, ctx("refresh")) : undefined,
      expiresAt: r.accessTokenExpiresAt,
      connectedAt: r.createdAt,
    };
  }

  async save(customerId: string, principalId: string, provider: string, c: StoredConnection): Promise<void> {
    const ctx = (w: string) => PersonalConnectionStore.context(customerId, principalId, provider, w);
    await this.rows.upsert({
      customerId,
      principalId,
      provider,
      accountEmail: c.accountEmail ?? null,
      connectedBy: c.connectedBy ?? null,
      scopes: c.scopes,
      accessTokenSealed: this.sealer.seal(c.accessToken, ctx("access")),
      refreshTokenSealed: c.refreshToken ? this.sealer.seal(c.refreshToken, ctx("refresh")) : null,
      accessTokenExpiresAt: c.expiresAt,
    });
  }

  delete(customerId: string, principalId: string, provider: string) {
    return this.rows.delete(customerId, principalId, provider);
  }
}

/** PKCE (RFC 7636) verifier and S256 challenge, plus an unguessable state. */
export function newAuthorizationRequest() {
  const codeVerifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(32).toString("base64url"),
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

type Fetch = typeof fetch;

export class GoogleOAuthClient {
  constructor(
    private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  authorizationUrl(req: { state: string; codeChallenge: string; loginHint?: string }): string {
    const u = new URL(this.endpoints.authorize);
    u.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      state: req.state,
      code_challenge: req.codeChallenge,
      code_challenge_method: "S256",
      // A refresh token, so the calendar keeps working after the first hour.
      access_type: "offline",
      prompt: "consent",
      ...(req.loginHint ? { login_hint: req.loginHint } : {}),
    }).toString();
    return u.toString();
  }

  private async tokenRequest(body: Record<string, string>, signal?: AbortSignal) {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoints.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...body }),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ConnectorError("unavailable", "Google sign-in is unreachable", "google-calendar");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // invalid_grant: the user revoked access, or the code/refresh token is no longer valid.
      const kind = json.error === "invalid_grant" ? "denied" : res.status >= 500 ? "unavailable" : "invalid_input";
      throw new ConnectorError(kind, `Google token request failed: ${String(json.error ?? res.status)}`, "google-calendar");
    }
    return json;
  }

  async exchangeCode(code: string, codeVerifier: string, now = new Date()): Promise<StoredConnection> {
    const j = await this.tokenRequest({ grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: this.cfg.redirectUri });
    const scopes = String(j.scope ?? "").split(" ").filter(Boolean);
    if (!scopes.includes(GOOGLE_CALENDAR_SCOPE)) throw new ConnectorError("denied", "Calendar access was not granted", "google-calendar");
    return {
      accountEmail: emailFromIdToken(j.id_token),
      scopes,
      accessToken: String(j.access_token),
      refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : undefined,
      expiresAt: new Date(now.getTime() + Number(j.expires_in ?? 3600) * 1000),
    };
  }

  async refresh(refreshToken: string, now = new Date()) {
    const j = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    return { accessToken: String(j.access_token), expiresAt: new Date(now.getTime() + Number(j.expires_in ?? 3600) * 1000) };
  }

  /** Best effort: the local copy is deleted whether or not Google answers. */
  async revoke(token: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.endpoints.revoke, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * The id_token comes straight from Google's token endpoint over TLS, so its
 * claims can be read without verifying the signature (OIDC Core 3.1.3.7). It
 * is used only to show which account is connected.
 */
function emailFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email.slice(0, 320) : undefined;
  } catch {
    return undefined;
  }
}

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string }[];
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The signed-in user's Google Calendar, read-only. Same tool contract as the
 * synthetic calendar MCP (`events_list {owner, days}` → `{events}`), so the
 * existing `calendar.events.list` capability binds to it unchanged. `owner`
 * comes from the trusted caller, never from the model (capability binding).
 */
export class GoogleCalendarConnector implements Connector {
  readonly id = "google-calendar";
  readonly kind = "oauth" as const;

  constructor(
    private readonly opts: {
      customerId: string;
      oauth: GoogleOAuthClient;
      store: PersonalConnectionStore;
      endpoints?: GoogleEndpoints;
      fetchImpl?: Fetch;
      now?: () => Date;
      maxEvents?: number;
    },
  ) {}

  private get now() {
    return this.opts.now?.() ?? new Date();
  }

  /** A valid access token for this user, refreshed when it is about to expire. */
  private async accessToken(principalId: string, signal?: AbortSignal, force = false): Promise<string> {
    const c = await this.opts.store.get(this.opts.customerId, principalId, "google");
    if (!c) throw new ConnectorError("denied", "Google Calendar is not connected for this user. Connect it under Your connections.", this.id);
    if (!force && c.expiresAt.getTime() - 60_000 > this.now.getTime()) return c.accessToken;
    if (!c.refreshToken) throw new ConnectorError("denied", "Google access has expired. Reconnect Google Calendar under Your connections.", this.id);
    try {
      const r = await this.opts.oauth.refresh(c.refreshToken, this.now);
      await this.opts.store.save(this.opts.customerId, principalId, "google", { ...c, accessToken: r.accessToken, expiresAt: r.expiresAt });
      return r.accessToken;
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === "denied") {
        // Revoked at Google: forget the dead token so the UI shows "not connected".
        await this.opts.store.delete(this.opts.customerId, principalId, "google");
        throw new ConnectorError("denied", "Google access was revoked. Reconnect Google Calendar under Your connections.", this.id);
      }
      throw err;
    }
  }

  async call(tool: string, args: Record<string, unknown>, opts: ConnectorCallOptions): Promise<ConnectorResult> {
    if (tool !== "events_list" || opts.classification !== "read") throw new ConnectorError("invalid_input", `unsupported tool ${tool}`, this.id);
    const owner = String(args.owner ?? "");
    const days = Math.min(14, Math.max(1, Number(args.days) || 7));
    if (!owner) throw new ConnectorError("invalid_input", "owner is required", this.id);
    const from = this.now;
    const u = new URL("/calendar/v3/calendars/primary/events", this.opts.endpoints?.api ?? GOOGLE_ENDPOINTS.api);
    u.search = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: new Date(from.getTime() + days * 86_400_000).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(this.opts.maxEvents ?? 20),
    }).toString();

    const get = async (token: string) => {
      try {
        return await (this.opts.fetchImpl ?? fetch)(u, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: opts.signal ?? AbortSignal.timeout(15_000) });
      } catch (err) {
        if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw new ConnectorError("unavailable", "Google Calendar timed out", this.id);
        throw new ConnectorError("unavailable", "Google Calendar is unreachable", this.id);
      }
    };
    let res = await get(await this.accessToken(owner, opts.signal));
    // A token revoked or expired early: refresh once and retry.
    if (res.status === 401) res = await get(await this.accessToken(owner, opts.signal, true));
    if (res.status === 401 || res.status === 403) throw new ConnectorError("denied", "Google Calendar refused access", this.id);
    if (res.status === 429) throw new ConnectorError("throttled", "Google Calendar rate limit", this.id);
    if (!res.ok) throw new ConnectorError("unavailable", `Google Calendar error ${res.status}`, this.id);
    const text = await res.text();
    if (text.length > 1_000_000) throw new ConnectorError("unavailable", "Google Calendar response too large", this.id);
    const items = ((JSON.parse(text) as { items?: GoogleEvent[] }).items ?? []).filter((e) => e.status !== "cancelled");
    const events = items.map((e) => ({
      id: `gcal-${clip(e.id, 200)}`,
      title: clip(e.summary, 200) || "(no title)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      location: clip(e.location, 300),
      attendees: (e.attendees ?? []).slice(0, 50).map((a) => clip(a.displayName || a.email, 200)),
      // Untrusted text from whoever created the invite; bounded, and treated as data by the runtime.
      agenda: clip(e.description?.replace(/<[^>]*>/g, " "), 2000),
    }));
    return { data: { events }, text: JSON.stringify({ events }).slice(0, 16_384) };
  }

  async tools(): Promise<ConnectorToolStatus[]> {
    return [{ name: "events_list", enabled: true }];
  }

  async health() {
    return { ok: true, detail: "per-user Google connection (read-only calendar)" };
  }

  async close() {}
}
