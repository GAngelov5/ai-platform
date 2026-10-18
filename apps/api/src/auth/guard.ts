import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "@platform/contracts";
import { constantTimeEqual, createTrustedContext, hashToken } from "@platform/security";
import type { PlatformDeps } from "../deps.js";
import { PUBLIC_ROUTE } from "./decorators.js";
import type { PlatformRequest } from "./http.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Global authentication guard. The only place a TrustedContext is created.
 * Identity comes exclusively from the server-side session record; headers or
 * body fields such as x-principal-id / principalId are never consulted.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly deps: PlatformDeps,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const req = ec.switchToHttp().getRequest<PlatformRequest>();
    const { config, repos } = this.deps;

    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== config.api.publicOrigin) throw new ForbiddenException("cross-origin request rejected");
      const header = req.headers[CSRF_HEADER];
      const cookie = req.cookies[CSRF_COOKIE];
      if (typeof header !== "string" || !cookie || !constantTimeEqual(header, cookie)) {
        throw new ForbiddenException("missing or invalid CSRF token");
      }
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [ec.getHandler(), ec.getClass()]);
    if (isPublic) return true;

    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException();
    const tokenHash = hashToken(token);
    const session = await repos.sessions.findActive(tokenHash);
    if (!session || session.customerId !== config.customerId || session.authMode !== config.auth.mode) {
      throw new UnauthorizedException();
    }
    const principal = await repos.principals.get(session.customerId, session.principalId);
    if (!principal || principal.disabled) throw new UnauthorizedException();
    if (principal.origin === "fixture" && !(config.auth.mode === "dev" && config.auth.devAuthEnabled)) {
      throw new UnauthorizedException();
    }

    req.principal = principal;
    req.sessionTokenHash = tokenHash;
    req.trustedContext = createTrustedContext({
      customerId: session.customerId,
      principalId: principal.id,
      policyVersion: config.policyVersion,
      requestId: req.requestId,
    });
    return true;
  }
}
