import * as client from "openid-client";
import { createHash } from "node:crypto";
import type { PlatformConfig } from "@platform/security";

type OidcConfig = Extract<PlatformConfig["auth"], { mode: "oidc" }>;

export interface SignedInIdentity {
  principalId: string;
  displayName: string;
  email?: string;
  /** Platform groups, mapped from the directory's groups. */
  groups: string[];
  roles: string[];
  /** Directory groups as the identity provider sent them (audit only). */
  directoryGroups: string[];
}

/**
 * Sign-in through the customer's identity provider (OpenID Connect,
 * authorization code flow with PKCE). The ID token is validated in full:
 * signature against the provider's published keys (enableNonRepudiationChecks),
 * issuer, audience, expiry and nonce. The provider's own metadata is fetched once (discovery).
 */
export class OidcLogin {
  private configuration?: Promise<client.Configuration>;

  constructor(
    private readonly cfg: OidcConfig,
    /** Tests only: a local fake identity provider. */
    private readonly opts: { fetch?: typeof fetch; allowHttp?: boolean } = {},
  ) {}

  private config(): Promise<client.Configuration> {
    this.configuration ??= client
      .discovery(new URL(this.cfg.issuer), this.cfg.clientId, this.cfg.clientSecret, undefined, {
        // Plain http is only for a local test identity provider; production config requires https.
        ...(this.opts.allowHttp ? { execute: [client.allowInsecureRequests] } : {}),
        ...(this.opts.fetch ? { [client.customFetch]: this.opts.fetch } : {}),
      })
      .then((config) => {
        // Also verify the ID token's signature against the provider's published keys. The library
        // otherwise trusts tokens from the token endpoint on the strength of TLS alone (allowed by
        // OIDC Core 3.1.3.7); checking the signature too guards against a misrouted or plain-http hop.
        client.enableNonRepudiationChecks(config);
        return config;
      })
      .catch((err) => {
        this.configuration = undefined; // retry discovery on the next sign-in
        throw err;
      });
    return this.configuration;
  }

  /** Where to send the browser, plus the secrets to keep until it comes back. */
  async start(nonce: string) {
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const url = client.buildAuthorizationUrl(await this.config(), {
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url: url.href, state, codeVerifier };
  }

  /** Exchanges the code and validates the ID token; throws on anything that doesn't check out. */
  async finish(query: URLSearchParams, expected: { state: string; nonce: string; codeVerifier: string }): Promise<SignedInIdentity> {
    const callback = new URL(this.cfg.redirectUri);
    callback.search = query.toString();
    const tokens = await client.authorizationCodeGrant(await this.config(), callback, {
      pkceCodeVerifier: expected.codeVerifier,
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error("ID token without a subject");
    return this.identity(claims as Record<string, unknown>);
  }

  /** Maps ID-token claims to a platform identity. Unmapped directory groups grant nothing. */
  identity(claims: Record<string, unknown>): SignedInIdentity {
    const raw = claims[this.cfg.groupsClaim];
    const directoryGroups = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((g): g is string => typeof g === "string").slice(0, 500);
    // Keycloak sends group paths ("/atlas-team"); accept the map key with or without the slash.
    const lookup = (g: string) => this.cfg.groupMap[g] ?? this.cfg.groupMap[g.replace(/^\//, "")];
    const groups = [...new Set(directoryGroups.map(lookup).filter((g): g is string => !!g))].sort();
    const isAdmin = directoryGroups.some((g) => this.cfg.adminGroups.includes(g) || this.cfg.adminGroups.includes(g.replace(/^\//, "")));
    const email = typeof claims.email === "string" && claims.email_verified !== false ? claims.email.toLowerCase().slice(0, 320) : undefined;
    const name = [claims.name, claims.preferred_username, email].find((v): v is string => typeof v === "string" && v.trim() !== "");
    return {
      principalId: principalIdFor(String(claims.sub)),
      displayName: (name ?? String(claims.sub)).slice(0, 200),
      email,
      groups,
      roles: isAdmin ? ["user", "admin"] : ["user"],
      directoryGroups,
    };
  }
}

/**
 * A stable platform id for the provider's subject. Ids allow [A-Za-z0-9._:#-];
 * a subject with other characters ("google-oauth2|123") keeps a readable form
 * plus a hash, so two subjects can never collide.
 */
export function principalIdFor(sub: string): string {
  const safe = sub.replace(/[^A-Za-z0-9._:#-]/g, "_").slice(0, 120);
  return safe === sub ? `u:${sub}` : `u:${safe}--${createHash("sha256").update(sub).digest("hex").slice(0, 12)}`;
}
