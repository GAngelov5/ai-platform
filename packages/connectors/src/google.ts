import { createHash, randomBytes } from "node:crypto";
import type { SecretSealer } from "@platform/security";
import { ConnectorError, type Connector, type ConnectorCallOptions, type ConnectorResult, type ConnectorToolStatus } from "./types.js";

/**
 * Personal Google connections (ADR 0015). Each user connects their own
 * account; the platform holds a calendar-events token for that user only. It
 * reads events, and creates one only through an approved action.
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

/** The narrowest scope that reads and creates events: no calendar settings, no other calendars' sharing. */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** Granted by connections made before event creation: still reads, can't create. */
export const GOOGLE_CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_SCOPES = ["openid", "email", GOOGLE_CALENDAR_SCOPE] as const;
/** Whether a stored connection may create events (false: reconnect to allow it). */
export const canCreateEvents = (scopes: readonly string[]) => scopes.includes(GOOGLE_CALENDAR_SCOPE);

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
  /**
   * Runs `fn` while holding a lock on the row (SELECT … FOR UPDATE in the
   * database), with `write` replacing it in the same transaction. For
   * providers that rotate refresh tokens: two processes refreshing at once
   * would otherwise invalidate each other's tokens. Optional: without it,
   * `PersonalConnectionStore.update` serialises within this process only.
   */
  withRowLock?<T>(
    customerId: string,
    principalId: string,
    provider: string,
    fn: (row: Awaited<ReturnType<SealedConnectionRows["get"]>>, write: (row: Parameters<SealedConnectionRows["upsert"]>[0]) => Promise<void>) => Promise<T>,
  ): Promise<T>;
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
    return this.open(customerId, principalId, provider, await this.rows.get(customerId, principalId, provider));
  }

  private open(customerId: string, principalId: string, provider: string, r: Awaited<ReturnType<SealedConnectionRows["get"]>>): (StoredConnection & { connectedAt: Date }) | undefined {
    if (!r) return undefined;
    const ctx = (w: string) => PersonalConnectionStore.context(customerId, principalId, provider, w);
    let accessToken: string;
    let refreshToken: string | undefined;
    try {
      accessToken = this.sealer.open(r.accessTokenSealed, ctx("access"));
      refreshToken = r.refreshTokenSealed ? this.sealer.open(r.refreshTokenSealed, ctx("refresh")) : undefined;
    } catch {
      // Sealed with another key (CONNECTION_ENCRYPTION_KEY changed) or tampered with: unusable,
      // so it reads as "not connected" and the user connects again; never an error page.
      return undefined;
    }
    return {
      accountEmail: r.accountEmail ?? undefined,
      connectedBy: r.connectedBy ?? undefined,
      scopes: r.scopes,
      accessToken,
      refreshToken,
      expiresAt: r.accessTokenExpiresAt,
      connectedAt: r.createdAt,
    };
  }

  async save(customerId: string, principalId: string, provider: string, c: StoredConnection): Promise<void> {
    await this.rows.upsert(this.sealRow(customerId, principalId, provider, c));
  }

  private sealRow(customerId: string, principalId: string, provider: string, c: StoredConnection): Parameters<SealedConnectionRows["upsert"]>[0] {
    const ctx = (w: string) => PersonalConnectionStore.context(customerId, principalId, provider, w);
    return {
      customerId,
      principalId,
      provider,
      accountEmail: c.accountEmail ?? null,
      connectedBy: c.connectedBy ?? null,
      scopes: c.scopes,
      accessTokenSealed: this.sealer.seal(c.accessToken, ctx("access")),
      refreshTokenSealed: c.refreshToken ? this.sealer.seal(c.refreshToken, ctx("refresh")) : null,
      accessTokenExpiresAt: c.expiresAt,
    };
  }

  private readonly local = new Map<string, Promise<unknown>>();

  /**
   * Read, then maybe replace, one connection while nobody else can: the row
   * is locked across processes when the rows support it, and always within
   * this process. `save` writes the new connection before the lock is released.
   */
  async update<T>(
    customerId: string,
    principalId: string,
    provider: string,
    fn: (current: (StoredConnection & { connectedAt: Date }) | undefined, save: (c: StoredConnection) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const key = `${customerId}|${principalId}|${provider}`;
    const run = () =>
      this.rows.withRowLock
        ? this.rows.withRowLock(customerId, principalId, provider, (row, write) =>
            fn(this.open(customerId, principalId, provider, row), (c) => write(this.sealRow(customerId, principalId, provider, c))),
          )
        : this.rows.get(customerId, principalId, provider).then((row) => fn(this.open(customerId, principalId, provider, row), (c) => this.save(customerId, principalId, provider, c)));
    const prev = this.local.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    this.local.set(key, next);
    try {
      return await next;
    } finally {
      if (this.local.get(key) === next) this.local.delete(key);
    }
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
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string }[];
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Arguments of `event_create`, built by the platform from an approved proposal (never by the model directly). */
export interface CreateEventArgs {
  owner: string;
  /** Client-chosen event id (base32hex), derived from the proposal's idempotency key: a retry can't create a second event. */
  eventId: string;
  title: string;
  /** "YYYY-MM-DD" (all day, end exclusive) or "YYYY-MM-DDTHH:MM" local to timeZone. */
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  description?: string;
  location?: string;
  attendees?: string[];
}

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

  /** One authorised request to the Calendar API, refreshing the token once on a 401. */
  private async request(owner: string, url: URL, init: { method?: string; body?: unknown }, opts: ConnectorCallOptions): Promise<Response> {
    const send = async (token: string) => {
      try {
        return await (this.opts.fetchImpl ?? fetch)(url, {
          method: init.method ?? "GET",
          headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: opts.signal ?? AbortSignal.timeout(15_000),
        });
      } catch (err) {
        // A write may have reached Google before the connection failed: never report it as "not done".
        if (opts.classification === "write") throw new ConnectorError("ambiguous_outcome", "Google Calendar did not answer; checking whether the event was created", this.id);
        if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw new ConnectorError("unavailable", "Google Calendar timed out", this.id);
        throw new ConnectorError("unavailable", "Google Calendar is unreachable", this.id);
      }
    };
    let res = await send(await this.accessToken(owner, opts.signal));
    // A token revoked or expired early: refresh once and retry (a 401 means the request was not processed).
    if (res.status === 401) res = await send(await this.accessToken(owner, opts.signal, true));
    return res;
  }

  private eventsUrl(path = "") {
    return new URL(`/calendar/v3/calendars/primary/events${path}`, this.opts.endpoints?.api ?? GOOGLE_ENDPOINTS.api);
  }

  async call(tool: string, args: Record<string, unknown>, opts: ConnectorCallOptions): Promise<ConnectorResult> {
    if (tool === "event_create" && opts.classification === "write") return this.createEvent(args as unknown as CreateEventArgs, opts);
    if (tool === "event_get" && opts.classification === "read") return this.getEvent(String(args.owner ?? ""), String(args.eventId ?? ""), opts);
    if (tool !== "events_list" || opts.classification !== "read") throw new ConnectorError("invalid_input", `unsupported tool ${tool}`, this.id);
    const owner = String(args.owner ?? "");
    const days = Math.min(14, Math.max(1, Number(args.days) || 7));
    if (!owner) throw new ConnectorError("invalid_input", "owner is required", this.id);
    const from = this.now;
    const u = this.eventsUrl();
    u.search = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: new Date(from.getTime() + days * 86_400_000).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(this.opts.maxEvents ?? 20),
    }).toString();

    const res = await this.request(owner, u, {}, opts);
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

  /**
   * Creates one event on the owner's primary calendar. The event id comes from the
   * proposal, so a redelivered or retried execution finds the existing event (409)
   * instead of creating a second one.
   */
  private async createEvent(a: CreateEventArgs, opts: ConnectorCallOptions): Promise<ConnectorResult> {
    if (!a.owner || !/^[a-v0-9]{5,1024}$/.test(a.eventId ?? "")) throw new ConnectorError("invalid_input", "owner and a valid eventId are required", this.id);
    const when = (v: string) => (a.allDay ? { date: v } : { dateTime: `${v}:00`, timeZone: a.timeZone });
    const body = {
      id: a.eventId,
      summary: a.title,
      ...(a.description ? { description: a.description } : {}),
      ...(a.location ? { location: a.location } : {}),
      start: when(a.start),
      end: when(a.end),
      ...(a.attendees?.length ? { attendees: a.attendees.map((email) => ({ email })) } : {}),
    };
    const u = this.eventsUrl();
    // Attendees get Google's invitation email; that is stated on the approval card.
    u.search = new URLSearchParams({ sendUpdates: a.attendees?.length ? "all" : "none" }).toString();
    const res = await this.request(a.owner, u, { method: "POST", body }, opts);
    if (res.status === 409) {
      // Already created by an earlier attempt of this same proposal.
      const existing = await this.getEvent(a.owner, a.eventId, { ...opts, classification: "read" });
      const e = existing.data as { found: boolean };
      if (e.found) return { data: { ...e, created: false }, text: JSON.stringify(e) };
      throw new ConnectorError("invalid_input", "an event with this id exists but can't be read", this.id);
    }
    if (res.status === 403) {
      const why = await res.text().catch(() => "");
      if (/insufficient|scope/i.test(why)) throw new ConnectorError("denied", "Google Calendar was connected read-only. Reconnect it under Your connections to allow creating events.", this.id);
      throw new ConnectorError("denied", "Google Calendar refused to create the event", this.id);
    }
    if (res.status === 401) throw new ConnectorError("denied", "Google Calendar refused access", this.id);
    if (res.status === 429) throw new ConnectorError("throttled", "Google Calendar rate limit", this.id);
    if (res.status === 400) throw new ConnectorError("invalid_input", "Google Calendar rejected the event details", this.id);
    // A 5xx after a POST may or may not have created the event: reconcile by id.
    if (res.status >= 500) throw new ConnectorError("ambiguous_outcome", `Google Calendar error ${res.status}`, this.id);
    if (!res.ok) throw new ConnectorError("unavailable", `Google Calendar error ${res.status}`, this.id);
    const e = (await res.json().catch(() => ({}))) as GoogleEvent;
    const data = { found: true, created: true, eventId: clip(e.id, 1024) || a.eventId, htmlLink: clip(e.htmlLink, 2000) || undefined };
    return { data, text: JSON.stringify(data) };
  }

  private async getEvent(owner: string, eventId: string, opts: ConnectorCallOptions): Promise<ConnectorResult> {
    if (!owner || !/^[a-v0-9]{5,1024}$/.test(eventId)) throw new ConnectorError("invalid_input", "owner and a valid eventId are required", this.id);
    const res = await this.request(owner, this.eventsUrl(`/${eventId}`), {}, { ...opts, classification: "read" });
    if (res.status === 404 || res.status === 410) return { data: { found: false }, text: '{"found":false}' };
    if (res.status === 401 || res.status === 403) throw new ConnectorError("denied", "Google Calendar refused access", this.id);
    if (!res.ok) throw new ConnectorError("unavailable", `Google Calendar error ${res.status}`, this.id);
    const e = (await res.json().catch(() => ({}))) as GoogleEvent;
    if (e.status === "cancelled") return { data: { found: false }, text: '{"found":false}' };
    const data = { found: true, eventId: clip(e.id, 1024) || eventId, htmlLink: clip(e.htmlLink, 2000) || undefined };
    return { data, text: JSON.stringify(data) };
  }

  async tools(): Promise<ConnectorToolStatus[]> {
    return [
      { name: "events_list", enabled: true },
      { name: "event_create", enabled: true },
      { name: "event_get", enabled: true },
    ];
  }

  async health() {
    return { ok: true, detail: "per-user Google connection (calendar events)" };
  }

  async close() {}
}
