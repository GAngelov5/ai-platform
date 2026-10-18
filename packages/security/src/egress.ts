import { isIP } from "node:net";

export type ModelMode = "local" | "hybrid";

/**
 * Syntactic check that a hostname refers to the local environment: loopback,
 * RFC 1918 / ULA addresses, or a single-label service name on a private
 * Compose network. This is a configuration guard, not a substitute for
 * network-level egress tests (required before a real-data pilot).
 */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const parts = h.split(".").map(Number);
    const [a = -1, b = -1] = parts;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (kind === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd");
  // Single-label names (e.g. "vllm", "ollama") resolve on the private Compose network.
  return /^[a-z0-9-]+$/.test(h);
}

export function normalizeOrigin(url: string): string {
  return new URL(url).origin;
}

/**
 * Throws unless `url` is in the explicit allowlist, and (in local mode) refers
 * to a local host. Used before any outbound model or RAG call is configured.
 */
export function assertApprovedEndpoint(
  url: string,
  approvedOrigins: readonly string[],
  mode: ModelMode,
  purpose: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${purpose}: endpoint is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${purpose}: only http(s) endpoints are supported`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${purpose}: credentials must not be embedded in the endpoint URL`);
  }
  const approved = approvedOrigins.map(normalizeOrigin);
  if (!approved.includes(parsed.origin)) {
    throw new Error(`${purpose}: endpoint origin ${parsed.origin} is not in the approved endpoint list`);
  }
  if (mode === "local" && !isLocalHostname(parsed.hostname)) {
    throw new Error(`${purpose}: local model mode forbids non-local endpoint ${parsed.hostname}`);
  }
}
