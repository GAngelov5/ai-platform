import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SecretSealer } from "../src/index.js";

const key = randomBytes(32).toString("base64");

describe("SecretSealer", () => {
  it("round-trips, with a fresh IV every time", () => {
    const s = new SecretSealer(key);
    const a = s.seal("token-1", "google:access:c:alice");
    expect(a).not.toContain("token-1");
    expect(a).not.toBe(s.seal("token-1", "google:access:c:alice"));
    expect(s.open(a, "google:access:c:alice")).toBe("token-1");
  });

  it("refuses another context, a tampered value and another key", () => {
    const s = new SecretSealer(key);
    const a = s.seal("token-1", "ctx-a");
    expect(() => s.open(a, "ctx-b")).toThrow();
    const parts = a.split(".");
    parts[3] = Buffer.from("other").toString("base64url");
    expect(() => s.open(parts.join("."), "ctx-a")).toThrow();
    expect(() => new SecretSealer(randomBytes(32).toString("base64")).open(a, "ctx-a")).toThrow();
  });

  it("requires a 32-byte key", () => {
    expect(() => new SecretSealer(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
