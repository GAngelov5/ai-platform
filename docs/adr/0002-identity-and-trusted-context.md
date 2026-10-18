# ADR 0002 — TrustedContext, development identity and session security

Status: accepted (Phase 1) · Date: 2026-10-18

## Decision

- `TrustedContext {customerId, principalId, requestId, policyVersion}` is a
  branded, frozen type created **only** by the global API `AuthGuard` after the
  session cookie is resolved server-side. Controllers receive it via `@Ctx()`.
- Identity is never read from headers or bodies. Request schemas are strict:
  an unexpected `principalId`/`customerId` field yields `400`.
- Sessions: 256-bit random token in an `HttpOnly; SameSite=Strict` cookie
  (`Secure` when `COOKIE_SECURE=true`); only its SHA-256 hash is stored.
  Logout revokes server-side. Sessions bind auth mode and customer.
- CSRF: double-submit token (`platform_csrf` cookie + `x-csrf-token` header,
  constant-time compare) plus an `Origin` check on every unsafe method,
  including the public dev-login route.
- Development identity: three synthetic fixture principals
  (`fixtures/identities.json`), selectable only when `AUTH_MODE=dev`,
  `DEV_AUTH_ENABLED=true` and `APP_ENV != production`. Fixture principals are
  rejected by the guard if dev auth is later disabled.
- Production configuration requires `AUTH_MODE=oidc`, OIDC settings,
  `COOKIE_SECURE=true`, an https origin, a non-development DB password, a real
  knowledge provider and a real model. **OIDC itself is not implemented**; the
  API refuses to start with `AUTH_MODE=oidc` (exit 78) until Phase 7.
- Missing/forbidden resources return identical `404` bodies (no existence oracle).

## Consequences

The pilot cannot run in production mode until customer OIDC is built. This is
deliberate: there is no path to serve real users with synthetic identities.
