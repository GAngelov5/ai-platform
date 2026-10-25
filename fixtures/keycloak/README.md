# Keycloak test realm (synthetic)

A local identity provider for testing company sign-in (OIDC). Started by
`infra/compose/auth/compose.keycloak.yaml` at http://localhost:8180, realm
`company`. Test values only: never use them anywhere else.

| User | Password | Directory groups |
|---|---|---|
| alice | `alice-55854ad2` | Staff, Atlas Team |
| bob | `bob-9152c7fc` | Staff |
| carol | `carol-05edc205` | Staff, Atlas Team, Finance and Legal |
| dana | `dana-eee05832` | Staff, Platform Admins |

Client `company-brain`, secret `dev-oidc-16a8bde0c593a4955ef26696` (set `OIDC_CLIENT_SECRET` to it).

Keycloak admin console: http://localhost:8180/admin, user `admin`, password from
`KEYCLOAK_ADMIN_PASSWORD` (default `admin-dev-only`).
