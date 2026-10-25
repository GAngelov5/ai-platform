import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { connectionOwner, ConnectorError, newAuthorizationRequest, type OAuthProvider } from "@platform/connectors";
import { hashToken, NotFoundOrForbiddenError, type TrustedContext } from "@platform/security";
import { randomBytes } from "node:crypto";
import { Ctx, Public } from "../auth/decorators.js";
import type { PlatformRequest } from "../auth/http.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

const NONCE_COOKIE = "platform_oauth_nonce";
const STATE_TTL_MS = 10 * 60_000;
const callbackPath = (provider: string) => `/api/connections/${provider}/callback`;

/** Integrations that can have a "Connect" button, shown even before they are set up. */
const KNOWN: { id: string; title: string; scope: OAuthProvider["scope"] }[] = [
  { id: "google", title: "Google Calendar", scope: "personal" },
  { id: "notion", title: "Notion", scope: "organization" },
];

/**
 * "Connect" for every integration (ADR 0015). Each provider sends the browser
 * to its own sign-in and consent screen; the rest is the same for all:
 *
 * - personal connections (Google Calendar) belong to the user who made them;
 *   only they can see, use or remove them.
 * - organization connections (Notion) bring in content others will read, so
 *   only admins can make or remove them; everyone sees that they exist.
 *
 * The callback arrives from the provider as a cross-site navigation, so the
 * session cookie (SameSite=Strict) is not sent. It is authorized instead by
 * the single-use `state` (bound to the user who started) AND a nonce cookie
 * (SameSite=Lax, bound to the browser that started): a link started by
 * someone else cannot attach your account to their user.
 */
@Controller("connections")
export class ConnectionsController {
  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  private provider(id: string): OAuthProvider | undefined {
    return this.deps.connections.providers.find((p) => p.id === id);
  }

  private canManage(p: Pick<OAuthProvider, "scope">, roles: readonly string[]) {
    return p.scope === "personal" || roles.includes("admin");
  }

  /** Fails like a missing route for a provider that isn't configured, or that this user may not manage. */
  private manageable(id: string, req: PlatformRequest) {
    const p = this.provider(id);
    const store = this.deps.connections.store;
    if (!p || !store || !this.canManage(p, req.principal?.roles ?? [])) throw new NotFoundOrForbiddenError();
    return { p, store };
  }

  @Get()
  async list(@Ctx() ctx: TrustedContext, @Req() req: PlatformRequest) {
    const roles = req.principal?.roles ?? [];
    const store = this.deps.connections.store;
    return Promise.all(
      KNOWN.map(async (k) => {
        const p = this.provider(k.id);
        const c = p && store ? await store.get(ctx.customerId, connectionOwner(k, ctx.principalId), k.id) : undefined;
        const by = c?.connectedBy && k.scope === "organization" ? await this.deps.repos.principals.get(ctx.customerId, c.connectedBy) : undefined;
        return {
          provider: k.id,
          title: k.title,
          scope: k.scope,
          configured: !!p && !!store,
          connected: !!c,
          account: c?.accountEmail ?? null,
          connectedAt: c?.connectedAt.toISOString() ?? null,
          connectedBy: by?.displayName ?? null,
          canManage: this.canManage(k, roles),
        };
      }),
    );
  }

  /** Starts the authorization; the browser then navigates to the returned provider URL. */
  @Post(":provider/start")
  @HttpCode(200)
  async start(@Ctx() ctx: TrustedContext, @Req() req: PlatformRequest, @Param("provider") id: string, @Res({ passthrough: true }) res: Response) {
    const { p } = this.manageable(id, req);
    const auth = newAuthorizationRequest();
    const nonce = randomBytes(32).toString("base64url");
    await this.deps.repos.oauthStates.create({
      state: auth.state,
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      provider: p.id,
      browserNonceHash: hashToken(nonce),
      codeVerifier: auth.codeVerifier,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    res.cookie(NONCE_COOKIE, nonce, { httpOnly: true, secure: this.deps.config.api.cookieSecure, sameSite: "lax", path: callbackPath(p.id), maxAge: STATE_TTL_MS });
    return { url: p.authorizationUrl({ state: auth.state, codeChallenge: auth.codeChallenge }) };
  }

  @Public()
  @Get(":provider/callback")
  async callback(
    @Req() req: PlatformRequest,
    @Res() res: Response,
    @Param("provider") id: string,
    @Query("state") state?: string,
    @Query("code") code?: string,
    @Query("error") error?: string,
  ) {
    const p = this.provider(id);
    const store = this.deps.connections.store;
    const done = (result: string) => {
      if (p) res.clearCookie(NONCE_COOKIE, { path: callbackPath(p.id) });
      res.redirect(302, `/connections?provider=${p?.id ?? "unknown"}&result=${result}`);
    };
    if (!p || !store || typeof state !== "string" || state.length > 100) return done("error");
    const customerId = this.deps.config.customerId;
    // Consume the state first, whatever happens next: a callback can be used once.
    const row = await this.deps.repos.oauthStates.take(state);
    const nonce = req.cookies[NONCE_COOKIE];
    if (!row || row.provider !== p.id || row.customerId !== customerId || typeof nonce !== "string" || hashToken(nonce) !== row.browserNonceHash) {
      await this.deps.repos.audit.write({ customerId, action: `connection.${p.id}.callback_rejected`, outcome: "denied", requestId: req.requestId }).catch(() => {});
      return done("error");
    }
    const audit = (outcome: "ok" | "denied" | "error", detail: Record<string, unknown>) =>
      this.deps.repos.audit
        .write({ customerId, principalId: row.principalId, requestId: req.requestId, action: `connection.${p.id}.connected`, resourceType: "connection", resourceId: p.id, outcome, detail })
        .catch(() => {});
    if (error || typeof code !== "string") {
      await audit("denied", { reason: String(error ?? "no code").slice(0, 100) });
      return done(error === "access_denied" ? "cancelled" : "error");
    }
    // Re-checked now: the user must still exist, be enabled and (for organization connections) still be an admin.
    const principal = await this.deps.repos.principals.get(customerId, row.principalId);
    if (!principal || principal.disabled || !this.canManage(p, principal.roles)) return done("error");
    try {
      const c = await p.exchangeCode(code, row.codeVerifier);
      await store.save(customerId, connectionOwner(p, row.principalId), p.id, { ...c, connectedBy: row.principalId });
      await audit("ok", { scopes: c.scopes.filter((s) => !s.includes(" ")).slice(0, 10), scope: p.scope });
      await this.afterChange(p, row.principalId);
      return done("connected");
    } catch (err) {
      await audit("error", { kind: err instanceof ConnectorError ? err.kind : "error" });
      return done(err instanceof ConnectorError && err.kind === "denied" ? "missing_scope" : "error");
    }
  }

  /** Removes the connection here and revokes the grant at the provider where it supports that. */
  @Delete(":provider")
  async disconnect(@Ctx() ctx: TrustedContext, @Req() req: PlatformRequest, @Param("provider") id: string) {
    const { p, store } = this.manageable(id, req);
    const owner = connectionOwner(p, ctx.principalId);
    const c = await store.get(ctx.customerId, owner, p.id);
    if (!c) return { connected: false, revokedAtProvider: false };
    const revoked = await p.revoke(c);
    await store.delete(ctx.customerId, owner, p.id);
    await this.deps.repos.audit.write({
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      action: `connection.${p.id}.disconnected`,
      resourceType: "connection",
      resourceId: p.id,
      outcome: "ok",
      detail: { revokedAtProvider: revoked, scope: p.scope },
    });
    await this.afterChange(p, ctx.principalId);
    return { connected: false, revokedAtProvider: revoked };
  }

  /** A Notion (dis)connection changes what is indexed: ask the worker to sync the source within a minute. */
  private async afterChange(p: OAuthProvider, principalId: string) {
    if (p.id === "notion" && this.deps.config.ingestion.notion) {
      await this.deps.admin.requestSync(this.deps.config.customerId, "notion", principalId, new Date());
    }
  }
}
