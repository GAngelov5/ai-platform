# ADR 0016 — Company sign-in (OpenID Connect)

Status: accepted · Date: 2026-10-25 · Builds on ADR 0002 (identity and TrustedContext)

## Question

Production refused to start in `AUTH_MODE=oidc` ("not implemented"). How do
real users sign in, and how do their permissions follow the company directory?

## Decisions

1. **Authorization code flow with PKCE (S256)** through `openid-client` 6, a
   certified implementation. The provider's metadata comes from discovery.
2. **The ID token is validated in full:** signature against the provider's
   published keys, issuer, audience, expiry and nonce.
   - `openid-client` by default trusts tokens from the token endpoint on the
     strength of TLS alone (OIDC Core 3.1.3.7). A test showed that a token
     signed with an unknown key was then accepted.
   - We enable `enableNonRepudiationChecks`, so the signature is always
     verified as well.
3. **The pending login is single-use and bound to the browser.**
   - State and the PKCE verifier are stored server-side with a 10-minute
     expiry, and consumed on first use.
   - A nonce cookie (`SameSite=Lax`, `HttpOnly`, scoped to the callback path)
     binds the login to the browser that started it. Its hash is the OIDC
     nonce that the ID token must carry.
   - So a sign-in link started by someone else, a replayed callback, or a
     token for another login are all rejected.
4. **Just-in-time provisioning.**
   - The first sign-in creates the principal (`u:<subject>`, with a hash when
     the subject has characters outside the id alphabet). It stores the name
     and the email, when that is verified.
   - Every sign-in refreshes name, email, groups and roles from the token.
   - Synthetic fixture principals are never overwritten, and a principal
     disabled in the platform is never re-enabled: their sign-in is refused,
     and existing sessions stop at once.
5. **Permissions follow the directory.**
   - `OIDC_GROUP_MAP` maps directory groups to platform groups. Keycloak's
     `/path` form is accepted, and unmapped groups grant nothing (fail closed).
   - The admin role goes to members of `OIDC_ADMIN_GROUPS`.
   - The audit log records sign-ins with the mapped groups, the roles and how
     many directory groups were unmapped.
6. **Development sign-in stays separate.**
   - In `AUTH_MODE=oidc` the synthetic picker is unavailable.
   - Production requires `oidc` and an `https` issuer.
   - Plain `http` issuers are accepted only outside production, for a local
     test provider.
7. **Sign-out ends the platform session.** Ending the provider's session
   (RP-initiated logout) is not implemented; with single sign-on, the next
   sign-in can go straight through.

## Evidence

- `apps/api/test/oidc.test.ts`, against an in-process fake provider that signs
  real RS256 tokens and checks PKCE and the client secret:
  - **Sign-in:** the redirect carries PKCE, state and nonce; the user is
    created with mapped groups and a verified email; permissions follow the
    groups (the Atlas team answers; staff only get nothing about Atlas).
  - **Roles and refresh:** the admin role comes from a directory group, and
    groups refresh on every sign-in.
  - **Rejected:** a callback from another browser, a replayed state, a forged
    signature, a wrong nonce, an invented state, and a disabled user (whose
    session also stops).
  - **Other:** a cancelled sign-in is reported, and dev sign-in returns 404.
- `fixtures/keycloak`: a test realm with the synthetic users and groups;
  `infra/compose/auth/compose.keycloak.yaml` runs it locally.

## Not done

- **Provider-side sign-out** (RP-initiated logout with `id_token_hint`).
- **Group sync without a sign-in** (SCIM, or Microsoft Graph and the Google
  Directory API). Until then, a directory change takes effect at the next
  sign-in or when the session expires.
- **Entra group overage:** a user in more than about 200 groups gets a link
  instead of a group list. That needs Graph and is not handled; map with app
  roles instead.
- **Email-based account linking** (for organisation-wide Google Workspace or
  Microsoft 365 data): the email is stored for this, but not used yet.
