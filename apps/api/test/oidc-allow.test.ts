/** Who may sign in when the provider serves the public (Google): allow-lists and default groups. */
import { describe, expect, it } from "vitest";
import { loadPlatformConfig, type PlatformConfig } from "@platform/security";
import { OidcLogin } from "../src/auth/oidc.js";

const login = (env: Record<string, string>) => {
  const auth = loadPlatformConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: "https://accounts.google.com", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", ...env }).auth;
  return new OidcLogin(auth as Extract<PlatformConfig["auth"], { mode: "oidc" }>);
};
const workspace = { sub: "1001", email: "alice@company.example", email_verified: true, hd: "company.example" };
const personal = { sub: "1002", email: "tester@gmail.example", email_verified: true };

describe("Google sign-in allow-lists", () => {
  it("a Workspace domain admits that Workspace's accounts only, by the hd claim", () => {
    const g = login({ OIDC_ALLOWED_DOMAINS: "company.example" });
    expect(g.allowed(workspace)).toBe(true);
    expect(g.allowed({ ...workspace, hd: "other.example" })).toBe(false);
    // A personal Google account registered with a company address has no hd: not a company account.
    expect(g.allowed({ ...workspace, hd: undefined })).toBe(false);
    expect(g.allowed(personal)).toBe(false);
  });

  it("listed addresses are admitted only when the provider verified them", () => {
    const g = login({ OIDC_ALLOWED_DOMAINS: "company.example", OIDC_ALLOWED_EMAILS: "Tester@gmail.example" });
    expect(g.allowed(personal)).toBe(true);
    expect(g.allowed({ ...personal, email: "TESTER@gmail.example" })).toBe(true);
    expect(g.allowed({ ...personal, email_verified: false })).toBe(false);
    expect(g.allowed({ ...personal, email: "someone@gmail.example" })).toBe(false);
    expect(g.allowed(workspace)).toBe(true);
  });

  it("other providers match the verified email's domain", () => {
    const k = login({ OIDC_ISSUER: "https://login.company.example/realms/company", OIDC_ALLOWED_DOMAINS: "company.example" });
    expect(k.allowed({ sub: "x", email: "bob@company.example", email_verified: true })).toBe(true);
    expect(k.allowed({ sub: "x", email: "bob@company.example", email_verified: false })).toBe(false);
    expect(k.allowed({ sub: "x", email: "bob@elsewhere.example", email_verified: true })).toBe(false);
    expect(login({ OIDC_ISSUER: "https://login.company.example/realms/company" }).allowed({ sub: "x" })).toBe(true); // own provider, no lists
  });

  it("everyone admitted gets the default groups (Google sends none)", () => {
    const g = login({ OIDC_ALLOWED_DOMAINS: "company.example", OIDC_DEFAULT_GROUPS: "all-staff" });
    expect(g.identity(workspace)).toMatchObject({ groups: ["all-staff"], roles: ["user"], email: "alice@company.example" });
  });
});
