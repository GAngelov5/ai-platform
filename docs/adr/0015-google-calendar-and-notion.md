# ADR 0015 — Google Calendar (personal connection) and Notion (source)

Status: accepted · Date: 2026-10-23 · Builds on ADR 0007, 0009 and 0011

## Question

The first real integrations are Google Calendar and Notion. How do they fit
the platform's rules?

- Live tools go through capabilities, with no token passthrough.
- Documents keep their permissions.
- There is no write without approval.
- There is no route to the internet.

## Decisions

### 1. Google Calendar is a personal connection, read-only

- Each user connects **their own** Google account under **Your connections**.
  The grant is OAuth 2.0 authorization code with **PKCE (S256)**, plus a
  refresh token (`access_type=offline`).
- Scopes are `openid email calendar.events.readonly`. That is the narrowest
  scope that lists events, with no settings and no writes. A grant without
  the calendar scope is refused ("Calendar access wasn't granted").
- The existing capability `calendar.events.list` binds to a
  `GoogleCalendarConnector` with the **same tool contract** as the synthetic
  calendar MCP (`events_list {owner, days}`). So the Meeting Preparation
  Assistant needed no change.
  - `owner` is the trusted caller, never a model argument (ADR 0011).
  - When Google is configured, it replaces the synthetic calendar: one
    capability, one source of truth.
- **The connector never takes a write.** Any tool other than `events_list`,
  or a write classification, is refused.
- **Tokens are sealed** with AES-256-GCM (`CONNECTION_ENCRYPTION_KEY`, 32
  bytes). The associated data binds a token to its provider, its kind
  (access or refresh) and its owner. A sealed value copied onto another
  user's row doesn't open.
- **Refresh:** the access token is refreshed one minute before expiry, and
  once more on a 401. If Google answers `invalid_grant` (revoked at Google),
  the local connection is deleted and the user is asked to reconnect.
- **Disconnect** revokes the grant at Google (best effort) and deletes it
  here. Connect, disconnect and rejected callbacks are audited, never with
  token values.
- **Untrusted content:** event descriptions are written by whoever sent the
  invite. They are bounded (2,000 characters), HTML is stripped, and the
  runtime treats them as data, like every live result.

### 2. The OAuth callback without the session cookie

Google's redirect back is a cross-site navigation, so the session cookie
(`SameSite=Strict`) isn't sent. The callback (`GET
/api/connections/google/callback`) is authorized instead by two checks:

1. The **state**: 32 random bytes, stored server-side with the user who
   started, the PKCE verifier and a 10-minute expiry. It is **consumed on
   first use**, whatever the outcome.
2. A **browser nonce cookie** (`platform_oauth_nonce`): `SameSite=Lax`,
   `HttpOnly`, scoped to the callback path. Its hash is stored with the
   state.

Without the second check, an attacker could start a flow for their own user
and send the link to a victim. The victim's Google account would end up on
the attacker's user. With the nonce, a link started elsewhere fails.

### 3. Notion is a source on the ingestion pipeline

- The new `NotionSourceAdapter` (ADR 0009 contract) uses an **internal
  integration** token (`NOTION_TOKEN`).
  - The token is resolved by reference; it is never in source configuration.
  - The integration needs only "Read content".
- **Scope** is exactly the pages someone shared with the integration in
  Notion. The platform cannot see the rest of the workspace.
- **Permissions:** an internal integration does not expose per-user page
  permissions. So every shared page gets one native group per configured
  platform group, mapped by the source's `aclMap` (`NOTION_ACL_GROUPS`,
  default `all-staff`). A group nobody has makes the pages unsearchable
  (fail closed). The guide says to share only what all those people may
  read.
- **Changes:** a full listing on each run, with `last_edited_time` as the
  version.
  - Unchanged pages are not fetched again.
  - A page that is no longer shared, archived or trashed is tombstoned.
  - A listing cut short by its limit is not treated as complete, so it
    deletes nothing.
- **Content:** blocks are converted to Markdown (headings, lists, to-dos,
  quotes, code, tables, toggles), nested up to 3 levels. The size is
  bounded, and an oversize page is quarantined. Child pages are separate
  items.
- **Rate limits:** about 3 requests per second, and a 429 is retried with
  `Retry-After`.
- **Where it is searchable:**
  - The source id `notion` is in every agent's knowledge scope.
  - It is in the LightRAG partitions' source lists, so pages land in the
    partition matching their groups.
  - It shows on Admin → Sources like any other source.

### 4. Egress: one allowlisting proxy

- The API and worker networks stay `internal` (no route out).
- `compose.saas.yaml` adds `egress-proxy`, the only service attached to a
  routable network.
- It tunnels **HTTPS CONNECT to port 443** of an exact host list
  (`oauth2.googleapis.com`, `www.googleapis.com`, `api.notion.com`). It
  refuses everything else, including plain HTTP forwarding. Each tunnel and
  refusal is logged.
- TLS stays end to end, so the proxy never sees tokens or content.
- Node's `fetch` uses it through `HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1`.
  Internal services are `http://` on private networks and never go through
  it.
- Google and Notion endpoints are fixed in code, so there is no
  configurable URL and no SSRF. Tests inject local fakes.
- The browser goes to `accounts.google.com` directly; that is the user's
  browser, not the server.

## Evidence

- `packages/connectors/test/google.test.ts` (against an in-process fake
  Google, `@platform/connectors/testing`):
  - the scopes and PKCE
  - a code works only with its verifier, and only once
  - a grant missing the calendar scope is refused
  - tokens are sealed and owner-bound
  - each user reads only their own calendar
  - the "not connected" error
  - refresh on expiry, and on a 401
  - a revoked grant is forgotten
  - writes are refused
- `packages/security/test/seal.test.ts`: the round trip, and the wrong
  context, tampering and wrong key all fail.
- `packages/knowledge/test/notion.test.ts` (against a fake Notion API, then
  through the real pipeline):
  - pagination, and archived pages skipped
  - the Markdown conversion, including nested blocks
  - a wrong token is reported clearly
  - a truncated listing is not treated as complete
  - the token is resolved by reference
  - groups are mapped, unshared pages are tombstoned, and unchanged pages
    are not refetched
- `services/egress-proxy/test`: other hosts, other ports, look-alike hosts,
  IP addresses and plain HTTP are all refused.
- **Checked by hand:** Node `fetch` went through the proxy to the real
  `api.notion.com` and got 401 (no token), while `example.com` was refused.
- `apps/api/test/api.test.ts`, "personal Google Calendar connection":
  - the full connect flow
  - Bob can't see Alice's connection
  - a callback without the browser nonce is rejected, and the state is
    burned
  - replays and invented states are rejected
  - a cancelled consent is reported, and starting needs a session
  - the Meeting Preparation Assistant cites Alice's Google event, and
    nothing of it reaches Bob
  - disconnect revokes and is audited, with no tokens in the audit
- **Browser:** the connections page in English and Bulgarian, including
  the cancelled state.

## Not verified yet

- Against the real Google and Notion APIs with your accounts (setup:
  [INTEGRATIONS-SETUP.md](../INTEGRATIONS-SETUP.md)). The fakes follow the
  documented API shapes, but they are not the real services.
- The Docker path through `egress-proxy` end to end. The proxy was tested
  on its own and with Node `fetch`.

## Limits and follow-ups

- **Testing mode:** while the Google OAuth app is in "Testing", only listed
  test users can connect, and refresh tokens expire after 7 days. A
  production rollout needs Google's app verification.
- **One Notion workspace and one access level per deployment.** For
  different groups, add more Notion sources with separate integrations
  (`KNOWLEDGE_SOURCES` JSON, `settings.tokenVar`).
- **No Google Workspace domain-wide delegation:** each user connects
  themselves. That is the least privilege, and it needs no Workspace admin.
- **Not built:** Gmail and Google Drive. Both would follow the same
  patterns: Gmail as a personal connection, Drive as a source.
