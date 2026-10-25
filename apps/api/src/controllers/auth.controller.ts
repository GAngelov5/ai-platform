import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { NotAllowedToSignIn } from "../auth/oidc.js";
import { CSRF_COOKIE, DevLoginRequestSchema, SESSION_COOKIE, type DevPrincipal, type MeResponse } from "@platform/contracts";
import { hashToken, newOpaqueToken } from "@platform/security";
import type { CookieOptions, Response } from "express";
import { Public } from "../auth/decorators.js";
import type { PlatformRequest } from "../auth/http.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

const LOGIN_COOKIE = "platform_login_nonce";
/**
 * Set by Sign out: the next company sign-in asks the provider to show its account
 * picker instead of passing straight through on the provider's own session.
 * Not a secret; it only changes what the provider shows.
 */
const SIGNED_OUT_COOKIE = "platform_signed_out";
const SIGNED_OUT_PATH = "/api/auth/oidc";
const LOGIN_TTL_MS = 10 * 60_000;

@Controller("auth")
export class AuthController {
  constructor(@Inject(DEPS) private readonly deps: PlatformDeps) {}

  private cookieBase(): CookieOptions {
    return { secure: this.deps.config.api.cookieSecure, sameSite: "strict", path: "/" };
  }

  private devAuthAvailable(): boolean {
    const { config } = this.deps;
    return config.env !== "production" && config.auth.mode === "dev" && config.auth.devAuthEnabled;
  }

  /** Issues (or re-issues) the double-submit CSRF token. */
  @Public()
  @Get("csrf")
  csrf(@Req() req: PlatformRequest, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies[CSRF_COOKIE] ?? newOpaqueToken(24);
    res.cookie(CSRF_COOKIE, token, { ...this.cookieBase(), httpOnly: false });
    return { token };
  }

  @Public()
  @Get("dev-principals")
  async devPrincipals(): Promise<DevPrincipal[]> {
    if (!this.devAuthAvailable()) throw new NotFoundException();
    const list = await this.deps.repos.principals.listByOrigin(this.deps.config.customerId, "fixture");
    return list.map((p) => ({ principalId: p.id, displayName: p.displayName, description: p.description }));
  }

  /** Synthetic development identity only. Disabled (404) unless DEV_AUTH_ENABLED in a non-production env. */
  @Public()
  @Post("dev-login")
  @HttpCode(200)
  async devLogin(@Req() req: PlatformRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<MeResponse> {
    if (!this.devAuthAvailable()) throw new NotFoundException();
    const { principalId } = DevLoginRequestSchema.parse(body);
    const { config, repos } = this.deps;
    const p = await repos.principals.get(config.customerId, principalId);
    if (!p || p.origin !== "fixture" || p.disabled) {
      await repos.audit.write({ customerId: config.customerId, requestId: req.requestId, action: "auth.dev_login", outcome: "denied" });
      throw new UnauthorizedException();
    }
    const token = newOpaqueToken();
    const ttlMs = config.api.sessionTtlMinutes * 60_000;
    await repos.sessions.create({
      tokenHash: hashToken(token),
      customerId: config.customerId,
      principalId: p.id,
      authMode: "dev",
      expiresAt: new Date(Date.now() + ttlMs),
    });
    res.cookie(SESSION_COOKIE, token, { ...this.cookieBase(), httpOnly: true, maxAge: ttlMs });
    await repos.audit.write({ customerId: config.customerId, principalId: p.id, requestId: req.requestId, action: "auth.dev_login", outcome: "allowed" });
    return { principalId: p.id, displayName: p.displayName, customerId: p.customerId, authMode: "dev", roles: [...p.roles] };
  }

  /**
   * Company sign-in, step 1: send the browser to the identity provider. The
   * pending login is kept server-side (single-use state, PKCE verifier) and
   * bound to this browser by a nonce cookie, whose hash is also the OIDC nonce
   * the ID token must carry.
   */
  @Public()
  @Get("oidc/login")
  async oidcLogin(@Req() req: PlatformRequest, @Res() res: Response) {
    const oidc = this.deps.oidc;
    if (!oidc) throw new NotFoundException();
    const browserNonce = randomBytes(32).toString("base64url");
    const nonce = hashToken(browserNonce);
    const { url, state, codeVerifier } = await oidc.start(nonce, { chooseAccount: req.cookies[SIGNED_OUT_COOKIE] === "1" });
    await this.deps.repos.oauthStates.create({
      state,
      customerId: this.deps.config.customerId,
      principalId: "@login",
      provider: "oidc-login",
      browserNonceHash: nonce,
      codeVerifier,
      expiresAt: new Date(Date.now() + LOGIN_TTL_MS),
    });
    res.cookie(LOGIN_COOKIE, browserNonce, { secure: this.deps.config.api.cookieSecure, sameSite: "lax", httpOnly: true, path: "/api/auth/oidc/callback", maxAge: LOGIN_TTL_MS });
    res.redirect(302, url);
  }

  /** Company sign-in, step 2: the provider sends the browser back here with a code. */
  @Public()
  @Get("oidc/callback")
  async oidcCallback(@Req() req: PlatformRequest, @Res() res: Response) {
    const { config, repos, oidc } = this.deps;
    if (!oidc) throw new NotFoundException();
    const query = new URLSearchParams(req.url.split("?")[1] ?? "");
    const fail = async (reason: string) => {
      await repos.audit.write({ customerId: config.customerId, requestId: req.requestId, action: "auth.oidc_login", outcome: "denied", detail: { reason } }).catch(() => {});
      res.clearCookie(LOGIN_COOKIE, { path: "/api/auth/oidc/callback" });
      res.redirect(302, `/?login=${reason === "cancelled" || reason === "not_allowed" ? reason : "error"}`);
    };
    const state = query.get("state");
    if (!state || state.length > 200) return fail("no_state");
    // Single use: consumed before anything else, whatever happens next.
    const pending = await repos.oauthStates.take(state);
    const browserNonce = req.cookies[LOGIN_COOKIE];
    if (!pending || pending.provider !== "oidc-login" || typeof browserNonce !== "string" || hashToken(browserNonce) !== pending.browserNonceHash) return fail("state_mismatch");
    if (query.get("error")) return fail(query.get("error") === "access_denied" ? "cancelled" : "provider_error");
    let identity;
    try {
      identity = await oidc.finish(query, { state, nonce: pending.browserNonceHash, codeVerifier: pending.codeVerifier });
    } catch (err) {
      if (err instanceof NotAllowedToSignIn) return fail("not_allowed");
      this.deps.logger.warn({ requestId: req.requestId, err: (err as Error).message }, "oidc sign-in rejected");
      return fail("token_rejected");
    }
    let principal;
    try {
      principal = await repos.principals.upsertFromIdentityProvider({ customerId: config.customerId, id: identity.principalId, displayName: identity.displayName, email: identity.email, groups: identity.groups, roles: identity.roles });
    } catch {
      return fail("principal_conflict");
    }
    if (principal.disabled) return fail("disabled");
    const token = newOpaqueToken();
    const ttlMs = config.api.sessionTtlMinutes * 60_000;
    await repos.sessions.create({ tokenHash: hashToken(token), customerId: config.customerId, principalId: principal.id, authMode: "oidc", expiresAt: new Date(Date.now() + ttlMs) });
    await repos.audit.write({
      customerId: config.customerId,
      principalId: principal.id,
      requestId: req.requestId,
      action: "auth.oidc_login",
      outcome: "allowed",
      detail: { groups: identity.groups, roles: identity.roles, unmappedGroups: identity.directoryGroups.length - identity.groups.length },
    });
    res.clearCookie(LOGIN_COOKIE, { path: "/api/auth/oidc/callback" });
    res.clearCookie(SIGNED_OUT_COOKIE, { path: SIGNED_OUT_PATH });
    res.cookie(SESSION_COOKIE, token, { ...this.cookieBase(), httpOnly: true, maxAge: ttlMs });
    res.redirect(302, "/chat");
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: PlatformRequest, @Res({ passthrough: true }) res: Response) {
    if (req.sessionTokenHash) await this.deps.repos.sessions.revoke(req.sessionTokenHash);
    res.clearCookie(SESSION_COOKIE, { ...this.cookieBase(), httpOnly: true });
    if (this.deps.oidc) res.cookie(SIGNED_OUT_COOKIE, "1", { secure: this.deps.config.api.cookieSecure, sameSite: "lax", httpOnly: true, path: SIGNED_OUT_PATH, maxAge: 30 * 24 * 3600_000 });
  }

  @Get("me")
  me(@Req() req: PlatformRequest): MeResponse {
    const p = req.principal!;
    return { principalId: p.id, displayName: p.displayName, customerId: p.customerId, authMode: this.deps.config.auth.mode, roles: [...p.roles] };
  }
}
