import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { CSRF_COOKIE, DevLoginRequestSchema, SESSION_COOKIE, type DevPrincipal, type MeResponse } from "@platform/contracts";
import { hashToken, newOpaqueToken } from "@platform/security";
import type { CookieOptions, Response } from "express";
import { Public } from "../auth/decorators.js";
import type { PlatformRequest } from "../auth/http.js";
import type { PlatformDeps } from "../deps.js";
import { DEPS } from "../tokens.js";

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
    return { principalId: p.id, displayName: p.displayName, customerId: p.customerId, authMode: "dev" };
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: PlatformRequest, @Res({ passthrough: true }) res: Response) {
    if (req.sessionTokenHash) await this.deps.repos.sessions.revoke(req.sessionTokenHash);
    res.clearCookie(SESSION_COOKIE, { ...this.cookieBase(), httpOnly: true });
  }

  @Get("me")
  me(@Req() req: PlatformRequest): MeResponse {
    const p = req.principal!;
    return { principalId: p.id, displayName: p.displayName, customerId: p.customerId, authMode: this.deps.config.auth.mode };
  }
}
