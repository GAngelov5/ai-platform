# Setting up Google Calendar and Notion

What you need to do on the Google and Notion side, and how to start the
platform with it. About 15 minutes. Design and security: ADR 0015.

**Keep secrets out of chat and out of git.** Put them only in `.env` (which is
git-ignored) or in your shell. The platform never shows them in the UI, logs or
answers.

## What each integration does

| | Google Calendar | Notion |
|---|---|---|
| Kind | Personal connection: **each user** connects their own account | Organization connection: **an admin** connects the workspace once; its pages become a document source |
| Connect | **Connect Google Calendar** → Google's sign-in | **Connect Notion** → Notion's sign-in and page picker |
| Access | Read-only calendar events (`calendar.events.readonly`) | Only the pages picked on Notion's screen |
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

## 2. Notion: create a public integration (for the Connect button)

With this, an admin clicks **Connect Notion** on **Your connections** and is
sent to Notion's own sign-in screen. There they pick the workspace and the
exact pages to share. No token is copied by hand.

1. Go to https://www.notion.so/profile/integrations → **New integration**.
   - Type: **Public**. Workspace: yours.
   - Notion asks for a company name, website, privacy policy and terms URL.
     For testing, any of your own URLs will do.
   - **Redirect URIs**, add both:
     - `http://localhost:3000/api/connections/notion/callback` (local `pnpm dev`)
     - `https://localhost:8443/api/connections/notion/callback` (Docker stack)
     If Notion refuses the `http://` one, use the Docker stack (https).
   - **Capabilities**: tick only **Read content**. Leave update and insert
     content **off**, and set user information to **No user information**.
2. Save, then copy the **OAuth client ID** and **OAuth client secret**.

**Alternative, without a Connect button:** create an **Internal** integration
with the same capabilities. Copy its secret into `NOTION_TOKEN`, then in Notion
open each page → **⋯ → Connections → Connect to** → your integration.

Either way, Notion doesn't tell the platform who may read a page. So every
shared page is readable by the platform groups in `NOTION_ACL_GROUPS`, and
that is why only admins can connect Notion. Share only what all of those
people may see. The default is `all-staff`; use `atlas-team` for project
pages, for example.

## 3. Put the values in `.env`

```bash
GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=…
CONNECTION_ENCRYPTION_KEY=…          # output of: openssl rand -base64 32
NOTION_OAUTH_CLIENT_ID=…             # public integration (Connect button)
NOTION_OAUTH_CLIENT_SECRET=…
# or instead: NOTION_TOKEN=ntn_…     # internal integration
NOTION_ACL_GROUPS=all-staff
```

Keep the same `CONNECTION_ENCRYPTION_KEY` from then on. With a new key, stored
Google connections can't be opened, and users have to connect again.

## 4a. Run locally (quickest)

```bash
cd apps/worker && node --env-file=../../.env --conditions=@platform/source --import tsx src/main.ts migrate && cd ../..
pnpm dev:full
```

Open http://localhost:3000.

After **Connect Notion**, the worker indexes the pages within about a minute.
To index right away:

```bash
cd apps/worker && node --env-file=../../.env --conditions=@platform/source --import tsx src/main.ts ingest notion
```

## 4b. Run on the Docker stack

The API and worker have no internet route. Only the new `egress-proxy`
service has one, and it allows HTTPS to `oauth2.googleapis.com`,
`www.googleapis.com` and `api.notion.com` and nothing else.

```bash
set -a; source .env; set +a        # or export the variables
C="docker-compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  -f infra/compose/lightrag/compose.lightrag.yaml \
  -f infra/compose/integrations/compose.integrations.yaml \
  -f infra/compose/integrations/compose.saas.yaml"
for s in worker api web; do DOCKER_BUILDKIT=0 $C build $s; done
$C up -d
# After Connect Notion the worker syncs within a minute; or now:
$C exec worker node dist/main.js ingest notion --sync
```

Open https://localhost:8443. With a `.env` that sets `PUBLIC_ORIGIN` to
`http://localhost:3000`, override it here: `PUBLIC_ORIGIN=https://localhost:8443`.

## 5. Try it

1. Sign in (for example as Alice) → **Your connections** → **Connect Google
   Calendar** → choose your Google account → allow calendar access.
   - You're back on "Your connections", showing "Connected as you@gmail.com".
2. **Assistants → Meeting Preparation Assistant**: "Prepare me for my next
   meeting." It cites your real next event (live source `gcal-…`).
3. Sign in as **Dana** (admin) → **Your connections** → **Connect Notion** →
   sign in to Notion → choose the workspace and tick the pages to share →
   **Allow access**.
   - You're back on "Your connections", showing "Workspace … · connected by
     Dana".
   - Within about a minute, **Admin → Sources** shows the `notion` source with
     your pages. Other users see the card without a button.
4. **Assistants → Knowledge Assistant**: ask about something on a shared Notion
   page. The answer cites the page.
5. **Disconnect** removes the tokens here.
   - For Google, it also revokes the grant at Google.
   - For Notion, the next sync removes the pages from the index. Notion has no
     revoke call, so to remove the app there too, use Notion → Settings →
     Connections.

## Troubleshooting

| You see | Cause |
|---|---|
| Google: "Error 400: redirect_uri_mismatch" | The redirect URI isn't registered exactly as in step 1.4 (scheme, port and path must match). |
| Google: "Access blocked: app has not completed verification" | Your address isn't a test user (step 1.3). |
| "Calendar access wasn't granted" | The calendar checkbox was unticked on the consent screen. Connect again and tick it. |
| "Not set up for this deployment yet" | `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` didn't reach the API: restart it, and for Docker check that the `compose.saas.yaml` overlay is included. |
| No Connect Notion button | You're not an admin; only admins connect Notion. Or `NOTION_OAUTH_CLIENT_ID`/`SECRET` aren't set. |
| Notion: "Missing or invalid redirect_uri" | The redirect URI isn't registered exactly as in step 2.1. |
| Admin → Sources: notion with an error "check NOTION_TOKEN" or "connect Notion again" | Wrong or revoked secret, or the connection was removed in Notion. |
| Notion source has 0 documents | No page was picked on Notion's screen, or none shared with the internal integration. |
| Notion documents are "unsearchable" | `NOTION_ACL_GROUPS` names a group no user has. |
