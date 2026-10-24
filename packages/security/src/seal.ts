import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Symmetric sealing for stored credentials (ADR 0015): AES-256-GCM with a
 * random 96-bit IV. Format: "v1.<iv>.<tag>.<ciphertext>", base64url parts.
 * `context` (e.g. "google:cust_demo:alice") is bound as associated data, so a
 * sealed value copied to another user's row does not open.
 */
export class SecretSealer {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, "base64");
    if (this.key.length !== 32) throw new Error("the encryption key must be 32 bytes, base64-encoded");
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  open(sealed: string, context: string): string {
    const [v, iv, tag, body] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("unsupported sealed value");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(context, "utf8"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  }
}
