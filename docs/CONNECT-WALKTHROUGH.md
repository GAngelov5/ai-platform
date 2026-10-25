# Walkthrough: connecting Google Calendar and Notion

Click by click, from zero to "the assistant answers from my calendar and my
Notion pages". About 20 minutes. More detail and troubleshooting:
[INTEGRATIONS-SETUP.md](INTEGRATIONS-SETUP.md).

## Where the Connect buttons are

**Top-right corner → your name (for example "Dana Operator") → Your
connections**, or go straight to https://localhost:3000/connections.

The page has one card per integration:

| Card | Button | Who sees the button |
|---|---|---|
| Google Calendar | **Connect Google Calendar** | Everyone: each user connects their own calendar |
| Notion | **Connect Notion** | Admins only (Dana): Notion pages are shared with the whole team |

A card that says **"Not set up for this deployment yet"** has no button,
because the platform doesn't have that integration's OAuth client yet. Steps
1–3 add it.

---

## Step 1 · Google: create the OAuth client (≈8 min)

1. Open https://console.cloud.google.com → project selector (top left) → **New
   project** → name it `Company Brain dev` → **Create** → select it.
2. Search bar → **Google Calendar API** → **Enable**.
3. Left menu → **Google Auth Platform** (or **APIs & Services → OAuth consent
   screen**) → **Get started**:
   - App name: `Company Brain dev`; support email: yours → **Next**.
   - Audience: **External** → **Next**. Contact email: yours → **Next** →
     agree → **Create**.
4. **Data access** → **Add or remove scopes** → tick `.../auth/calendar.events.readonly`,
   `openid` and `.../auth/userinfo.email` → **Update** → **Save**.
5. **Audience** → **Test users** → **Add users** → your Gmail address →
   **Save**.
6. **Clients** → **Create client**:
   - Application type: **Web application**, name `localhost`.
   - **Authorized redirect URIs** → **Add URI** →
     `https://localhost:3000/api/connections/google/callback`
   - **Create**. Copy the **Client ID** and **Client secret**. The secret is
     shown in full only now.

## Step 2 · Notion: create the public integration (≈5 min)

1. Open https://www.notion.so/profile/integrations → **New integration**.
2. Name `Company Brain dev`, workspace: yours, type **Public**.
3. Fill in the company fields Notion asks for (name, website, privacy and
   terms URLs). For testing, your own URLs are fine.
4. **Redirect URIs**: `https://localhost:3000/api/connections/notion/callback`
5. **Save**. On the integration page:
   - **Capabilities**: only **Read content** ticked. Update and insert content
     **off**, user information **No user information**. Save.
   - Copy the **OAuth client ID** and **OAuth client secret**.

## Step 3 · Put the values in `.env` (≈2 min)

Make the encryption key in a terminal:

```bash
openssl rand -base64 32
```

Open `.env` in the project root (it is git-ignored) and add:

```bash
GOOGLE_OAUTH_CLIENT_ID=<from step 1.6>
GOOGLE_OAUTH_CLIENT_SECRET=<from step 1.6>
NOTION_OAUTH_CLIENT_ID=<from step 2.5>
NOTION_OAUTH_CLIENT_SECRET=<from step 2.5>
CONNECTION_ENCRYPTION_KEY=<output of openssl above>
NOTION_ACL_GROUPS=all-staff
```

Don't paste these values into chat. Keep the same encryption key from now on:
with a new key, existing connections can't be opened.

## Step 4 · Start the platform over HTTPS

Stop any running `pnpm dev` (Ctrl+C), then:

```bash
pnpm db:migrate
```
```bash
pnpm dev:https
```

Wait for `Ready` in the output, then open **https://localhost:3000**.
- The browser warns "Your connection is not private". Click **Advanced →
  Proceed to localhost**. This happens once: the certificate is self-signed.

## Step 5 · Connect Notion (as the admin)

1. On the sign-in page, choose **Dana Operator (platform admin)**.
2. Top right **Dana Operator → Your connections**.
3. Notion card → **Connect Notion**.
4. Notion opens: sign in → choose your workspace → **Select pages** → tick the
   pages to share → **Allow access**.
5. You're back on Your connections:
   - The Notion card shows **Connected** and "Workspace … · connected by Dana
     Operator".
6. Wait about a minute, then **Admin** (top menu) → **Sources**:
   - **notion** lists your pages under Documents and Indexed.
   - It's still 0 if the worker hasn't run yet: click **Sync now** and wait a
     minute.

## Step 6 · Connect your Google Calendar (as a user)

1. Top right **Dana Operator → Sign out**, then sign in as **Alice Atlas**.
2. **Alice Atlas → Your connections** → Google Calendar card → **Connect
   Google Calendar**.
3. Google opens: choose your Gmail account.
   - Expected for a test app: "Google hasn't verified this app". Click
     **Continue**.
   - Tick **See events on all your calendars** → **Continue**.
4. Back on Your connections: **Connected as you@gmail.com**.
   - The calendar is linked to Alice in the platform, but it is your real
     calendar.

## Step 7 · Ask the assistants

Still as Alice, **Assistants**:

| Assistant | Ask | Expect |
|---|---|---|
| Meeting Preparation Assistant | "Prepare me for my next meeting." | Your real next event (title, time, attendees), with a live citation |
| Knowledge Assistant | A question about something written on one of your shared Notion pages | An answer that cites the Notion page by its title |

The fake model (the default in `.env`) answers instantly but only extracts
sentences. With `MODEL_PROVIDER=openai-compatible` and Ollama, answers are
real prose but take minutes on CPU.

## Step 8 · Check permissions (optional)

- Sign in as **Bob**:
  - **Your connections** shows Google as *not connected*: Alice's connection is
    hers only.
  - The Notion card shows "connected by Dana Operator" with **no button**.
- Sign in as **Dana → Admin → Audit**, filter `connection.`:
  `connection.google.connected` and `connection.notion.connected`. No tokens
  are shown anywhere.

## Undo

- **Disconnect** on each card.
  - Google: access is also revoked at Google.
  - Notion: the pages are removed from the index within a minute. To remove
    the app in Notion too: Notion → Settings → Connections.

## If something goes wrong

| You see | Fix |
|---|---|
| Cards say "Not set up for this deployment yet" | The values in step 3 aren't in `.env`, or the server wasn't restarted. Stop `pnpm dev:https` and start it again. |
| No Notion button | You're not signed in as Dana. Only admins can connect Notion. |
| Google: `redirect_uri_mismatch` | The URI in step 1.6 must be exactly `https://localhost:3000/api/connections/google/callback`. |
| Google: "Access blocked" | Your Gmail address isn't in the Test users list (step 1.5). |
| Notion: an error about `redirect_uri` | The URI in step 2.4 must be exactly `https://localhost:3000/api/connections/notion/callback`. |
| "Connecting … failed" after returning | Wrong client secret in `.env`, or a mistyped `CONNECTION_ENCRYPTION_KEY` (it must be 44 characters ending in `=`). |
| The site is on `http://` instead of `https://` | You ran `pnpm dev` or `pnpm dev:full`. Use `pnpm dev:https`. |
