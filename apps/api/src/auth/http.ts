import type { Request } from "express";
import type { Principal, TrustedContext } from "@platform/security";

export interface PlatformRequest extends Request {
  requestId: string;
  cookies: Record<string, string>;
  trustedContext?: TrustedContext;
  principal?: Principal;
  sessionTokenHash?: string;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}
