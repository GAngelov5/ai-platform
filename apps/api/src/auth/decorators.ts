import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { TrustedContext } from "@platform/security";
import type { PlatformRequest } from "./http.js";

export const PUBLIC_ROUTE = "platform:public";
/** Marks a route as reachable without a session. CSRF checks still apply to unsafe methods. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/** Injects the server-created TrustedContext. Throws if the guard did not create one. */
export const Ctx = createParamDecorator((_: unknown, ec: ExecutionContext): TrustedContext => {
  const req = ec.switchToHttp().getRequest<PlatformRequest>();
  if (!req.trustedContext) throw new Error("TrustedContext missing: route is not authenticated");
  return req.trustedContext;
});
