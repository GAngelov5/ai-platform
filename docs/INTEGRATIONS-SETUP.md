# Setting up Google Calendar and Notion

What you need to do on the Google and Notion side, and how to start the
platform with it. About 15 minutes. Design and security: ADR 0015.

**Keep secrets out of chat and out of git.** Put them only in `.env` (which is
git-ignored) or in your shell. The platform never shows them in the UI, logs or
answers.

## What each integration does

| | Google Calendar | Notion |
|---|---|---|
| Kind | Personal connection: **each user** connects their own account | Document source for the whole deployment |
| Access | Read-only calendar events (`calendar.events.readonly`) | Only pages you explicitly share with the integration |
| Used by | Meeting Preparation Assistant (`calendar.events.list`) | Every assistant's document search, with citations |
| Who can read it | Only the user who connected it | The groups in `NOTION_ACL_GROUPS` (default `all-staff`) |
| Writes | None | None |

## 1. Google Calendar: create an OAuth client (Google Cloud Console)

1. Go to https://console.cloud.google.com and create a project (for example
   "Company Brain dev").
2. **APIs & Services → Library**: enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (now called **Google Auth
   Platform**):
   - User type: **External** (or Internal if you use Google Workspace and only
     your organisation will connect).
   - App name, support email: anything.
   - **Data access / Scopes**: add `.../auth/calendar.events.readonly`,
     `openid` and `email`.
   - **Audience / Test users**: add your own Google address. While the app is in
     "Testing", only test users can connect, and refresh tokens expire after 7
     days. That is fine for testing.
4. **Clients → Create client** (APIs & Services → Credentials → Create
   credentials → OAuth client ID):
   - Application type: **Web application**.
   - **Authorized redirect URIs**, add both:
     - `http://localhost:3000/api/connections/google/callback` (local `pnpm dev`)
     - `https://localhost:8443/api/connections/google/callback` (Docker stack)
5. Copy the **Client ID** and **Client secret**.

## 2. Notion: create an internal integration and share pages

1. Go to https://www.notion.so/profile/integrations → **New integration**.
   - Type: **Internal**. Workspace: yours.
   - **Capabilities**: tick only **Read content**. Leave update and insert
     content **off**, and user information to **No user information**.
2. Copy the **Internal Integration Secret** (it starts with `ntn_` or `secret_`).
3. In Notion, open each page you want searchable → **⋯ → Connections → Connect
   to** → your integration. Sub-pages of a shared page are included. Nothing
   else in your workspace is visible to the platform.

Notion doesn't tell an internal integration who may read a page. So every
shared page is readable by the platform groups in `NOTION_ACL_GROUPS`. Share
only what all of those people may see. The default is `all-staff`; use
`atlas-team` for project pages, for example.

## 3. Put the values in `.env`

```bash
GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=…
CONNECTION_ENCRYPTION_KEY=…          # output of: openssl rand -base64 32
NOTION_TOKEN=ntn_…
NOTION_ACL_GROUPS=all-staff
```

Keep the same `CONNECTION_ENCRYPTION_KEY` from then on. With a new key, stored
Google connections can't be opened, and users have to connect again.

## 4a. Run locally (quickest)

```bash
cd apps/worker && node --env-file=../../.env --conditions=@platform/source --import tsx src/main.ts migrate && cd ../..
pnpm dev:full
```

Index Notion right away (otherwise the worker picks it up within 15 minutes):

```bash
cd apps/worker && node --env-file=../../.env --conditions=@platform/source --import tsx src/main.ts ingest notion
```

Open http://localhost:3000.

## 4b. Run on the Docker stack

The API and worker have no internet route. Only the new `egress-proxy`
service has one, and it allows HTTPS to `oauth2.googleapis.com`,
`www.googleapis.com` and `api.notion.com` and nothing else.

```bash
set -a; source .env; set +a        # or export the five variables
C="docker-compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  -f infra/compose/lightrag/compose.lightrag.yaml \
  -f infra/compose/integrations/compose.integrations.yaml \
  -f infra/compose/integrations/compose.saas.yaml"
for s in worker api web; do DOCKER_BUILDKIT=0 $C build $s; done
$C up -d
$C exec worker node dist/main.js ingest notion --sync   # index Notion now, then into LightRAG
```

Open https://localhost:8443. With a `.env` that sets `PUBLIC_ORIGIN` to
`http://localhost:3000`, override it here: `PUBLIC_ORIGIN=https://localhost:8443`.

## 5. Try it

1. Sign in (for example as Alice) → **Your connections** → **Connect Google
   Calendar** → choose your Google account → allow calendar access.
   - You're back on "Your connections", showing "Connected as you@gmail.com".
2. **Assistants → Meeting Preparation Assistant**: "Prepare me for my next
   meeting." It cites your real next event (live source `gcal-…`).
3. **Assistants → Knowledge Assistant**: ask about something on a shared Notion
   page. The answer cites the page; **Admin → Sources** lists a `notion` source.
4. **Disconnect** on "Your connections" removes the tokens here and revokes the
   grant at Google.

## Troubleshooting

| You see | Cause |
|---|---|
| Google: "Error 400: redirect_uri_mismatch" | The redirect URI isn't registered exactly as in step 1.4 (scheme, port and path must match). |
| Google: "Access blocked: app has not completed verification" | Your address isn't a test user (step 1.3). |
| "Calendar access wasn't granted" | The calendar checkbox was unticked on the consent screen. Connect again and tick it. |
| "Not set up for this deployment yet" | `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` didn't reach the API: restart it, and for Docker check that the `compose.saas.yaml` overlay is included. |
| Admin → Sources: notion with an error "check NOTION_TOKEN" | Wrong or revoked integration secret. |
| Notion source has 0 documents | No page is shared with the integration (step 2.3). |
| Notion documents are "unsearchable" | `NOTION_ACL_GROUPS` names a group no user has. |
