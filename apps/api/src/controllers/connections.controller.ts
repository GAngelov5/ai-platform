import { Controller, Delete, Get, HttpCode, Inject, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { ConnectorError, GOOGLE_CALENDAR_SCOPE, newAuthorizationRequest } from "@platform/connectors";
import { hashToken, NotFoundOrForbiddenError, type TrustedContext } from "@platform/security";
import { randomBytes } from "node:crypto";
import { Ctx, Public } from "../auth/decorators.js";
import type { PlatformRequest } from "../auth/http.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

const NONCE_COOKIE = "platform_oauth_nonce";
const CALLBACK_PATH = "/api/connections/google/callback";
const STATE_TTL_MS = 10 * 60_000;

/**
 * Personal connections (ADR 0015): each user connects their own Google
 * account for a read-only calendar. Only the owner can see or remove a
 * connection; tokens never leave the server.
 *
 * The OAuth callback arrives from Google as a cross-site navigation, so the
 * session cookie (SameSite=Strict) is not sent. It is authorized instead by
 * the single-use `state` (bound to the user who started) AND a nonce cookie
 * (SameSite=Lax, bound to the browser that started): a link started by
 * someone else cannot attach your Google account to their user.
 */
@Controller("connections")
export class ConnectionsController {
  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  @Get()
  async list(@Ctx() ctx: TrustedContext) {
    const g = this.deps.google;
    const c = g ? await g.store.get(ctx.customerId, ctx.principalId, "google") : undefined;
    return [
      {
        provider: "google",
        title: "Google Calendar",
        configured: !!g,
        connected: !!c,
        accountEmail: c?.accountEmail ?? null,
        readOnly: true,
        connectedAt: c?.connectedAt.toISOString() ?? null,
      },
    ];
  }

  /** Starts the authorization; the browser then navigates to the returned Google URL. */
  @Post("google/start")
  @HttpCode(200)
  async start(@Ctx() ctx: TrustedContext, @Res({ passthrough: true }) res: Response) {
    const g = this.deps.google;
    if (!g) throw new NotFoundOrForbiddenError();
    const req = newAuthorizationRequest();
    const nonce = randomBytes(32).toString("base64url");
    await this.deps.repos.oauthStates.create({
      state: req.state,
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      provider: "google",
      browserNonceHash: hashToken(nonce),
      codeVerifier: req.codeVerifier,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    res.cookie(NONCE_COOKIE, nonce, { httpOnly: true, secure: this.deps.config.api.cookieSecure, sameSite: "lax", path: CALLBACK_PATH, maxAge: STATE_TTL_MS });
    return { url: g.oauth.authorizationUrl({ state: req.state, codeChallenge: req.codeChallenge }) };
  }

  @Public()
  @Get("google/callback")
  async callback(
    @Req() req: PlatformRequest,
    @Res() res: Response,
    @Query("state") state?: string,
    @Query("code") code?: string,
    @Query("error") error?: string,
  ) {
    const done = (result: string) => {
      res.clearCookie(NONCE_COOKIE, { path: CALLBACK_PATH });
      res.redirect(302, `/connections?google=${result}`);
    };
    const g = this.deps.google;
    if (!g || typeof state !== "string" || state.length > 100) return done("error");
    // Consume the state first, whatever happens next: a callback can be used once.
    const row = await this.deps.repos.oauthStates.take(state);
    const nonce = req.cookies[NONCE_COOKIE];
    if (!row || row.provider !== "google" || row.customerId !== this.deps.config.customerId || typeof nonce !== "string" || hashToken(nonce) !== row.browserNonceHash) {
      await this.deps.repos.audit.write({ customerId: this.deps.config.customerId, action: "connection.google.callback_rejected", outcome: "denied", requestId: req.requestId }).catch(() => {});
      return done("error");
    }
    const audit = (outcome: "ok" | "denied" | "error", detail: Record<string, unknown>) =>
      this.deps.repos.audit
        .write({ customerId: row.customerId, principalId: row.principalId, requestId: req.requestId, action: "connection.google.connected", resourceType: "connection", resourceId: "google", outcome, detail })
        .catch(() => {});
    if (error || typeof code !== "string") {
      await audit("denied", { reason: String(error ?? "no code").slice(0, 100) });
      return done(error === "access_denied" ? "cancelled" : "error");
    }
    const principal = await this.deps.repos.principals.get(row.customerId, row.principalId);
    if (!principal || principal.disabled) return done("error");
    try {
      const c = await g.oauth.exchangeCode(code, row.codeVerifier);
      await g.store.save(row.customerId, row.principalId, "google", c);
      await audit("ok", { scopes: c.scopes.filter((s) => s === GOOGLE_CALENDAR_SCOPE || s === "email" || s === "openid") });
      return done("connected");
    } catch (err) {
      await audit("error", { kind: err instanceof ConnectorError ? err.kind : "error" });
      return done(err instanceof ConnectorError && err.kind === "denied" ? "missing_scope" : "error");
    }
  }

  /** Removes the connection here and revokes the grant at Google (best effort). */
  @Delete("google")
  async disconnect(@Ctx() ctx: TrustedContext) {
    const g = this.deps.google;
    if (!g) throw new NotFoundOrForbiddenError();
    const c = await g.store.get(ctx.customerId, ctx.principalId, "google");
    if (!c) return { connected: false, revokedAtGoogle: false };
    const revoked = await g.oauth.revoke(c.refreshToken ?? c.accessToken);
    await g.store.delete(ctx.customerId, ctx.principalId, "google");
    await this.deps.repos.audit.write({
      customerId: ctx.customerId,
      principalId: ctx.principalId,
      requestId: ctx.requestId,
      action: "connection.google.disconnected",
      resourceType: "connection",
      resourceId: "google",
      outcome: "ok",
      detail: { revokedAtGoogle: revoked },
    });
    return { connected: false, revokedAtGoogle: revoked };
  }
}
