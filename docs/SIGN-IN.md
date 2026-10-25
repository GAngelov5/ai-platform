# Company sign-in (OIDC)

The platform signs people in through the company's own identity provider:
Microsoft Entra ID, Google Workspace, Okta, Keycloak or any OpenID Connect
provider. Design and security: ADR 0016.

- Users click **Sign in with your company account**, sign in on the provider's
  page and come back signed in.
- The first sign-in creates the user (name, email, groups). Every later sign-in
  refreshes the groups, so leaving a group in the directory removes access at
  the next sign-in.
- Directory groups are mapped to platform groups with `OIDC_GROUP_MAP`.
  Unmapped groups grant nothing.
- Admins are the members of the directory groups in `OIDC_ADMIN_GROUPS`.
- Development sign-in (the synthetic user picker) is off in this mode.

## Settings

```bash
AUTH_MODE=oidc
DEV_AUTH_ENABLED=false
OIDC_ISSUER=https://login.example.com/realms/company     # the provider's issuer URL
OIDC_CLIENT_ID=company-brain
OIDC_CLIENT_SECRET=…                                     # from the provider; .env or secret store only
OIDC_GROUP_MAP={"Staff":"all-staff","Atlas Team":"atlas-team","Finance and Legal":"finance-legal"}
OIDC_ADMIN_GROUPS=Platform Admins
# Optional:
OIDC_GROUPS_CLAIM=groups                                 # ID-token claim that lists groups
OIDC_SCOPES=openid email profile
```

Register this redirect URI at the provider: `<PUBLIC_ORIGIN>/api/auth/oidc/callback`,
for example `https://brain.company.com/api/auth/oidc/callback`. The provider
must put the user's groups into the ID token under `OIDC_GROUPS_CLAIM`.

| Provider | Groups in the ID token |
|---|---|
| Keycloak | Client scope or mapper "Group Membership" (claim `groups`) |
| Microsoft Entra ID | App registration → Token configuration → Add groups claim (sends group IDs; map the IDs) |
| Okta | Authorization server → Claims → `groups` with a filter |
| Google Workspace | Google's ID token has no groups: map everyone with one rule, or use another provider |

## Try it locally with Keycloak

1. Start the test provider (realm `company` with Alice, Bob, Carol and Dana):
   ```bash
   docker-compose -p keycloak-dev -f infra/compose/auth/compose.keycloak.yaml up -d
   ```
2. In `.env`, replace the sign-in lines:
   ```bash
   AUTH_MODE=oidc
   DEV_AUTH_ENABLED=false
   OIDC_ISSUER=http://localhost:8180/realms/company
   OIDC_CLIENT_ID=company-brain
   OIDC_CLIENT_SECRET=dev-oidc-16a8bde0c593a4955ef26696
   OIDC_GROUP_MAP={"Staff":"all-staff","Atlas Team":"atlas-team","Finance and Legal":"finance-legal"}
   OIDC_ADMIN_GROUPS=Platform Admins
   ```
3. Restart `pnpm dev:https` and open https://localhost:3000 → **Sign in with your
   company account**. Sign in as one of the users in
   [fixtures/keycloak/README.md](../fixtures/keycloak/README.md).

Users signed in this way are new platform users (`u:<id>`). The synthetic
development users and their conversations stay separate. Plain `http://` for
the issuer is accepted only outside production.

To go back to the synthetic user picker: `AUTH_MODE=dev`, `DEV_AUTH_ENABLED=true`.

## Signing out

**Sign out** ends the platform session. The provider's own session may stay
open (single sign-on), so the next **Sign in** can go straight through.
Disabling a user in the platform stops their session at once; removing them
from the directory takes effect at their next sign-in, or when their platform
session expires (`SESSION_TTL_MINUTES`, default 8 hours).
