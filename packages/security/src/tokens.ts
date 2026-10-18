import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Session tokens are stored only as SHA-256 hashes. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
