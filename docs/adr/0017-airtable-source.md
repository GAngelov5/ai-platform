# ADR 0017 — Airtable as an indexed knowledge source

Status: accepted · Date: 2026-10-26 · Addendum to ADR 0015 (builds on 0009 and 0011)

## Question

Teams keep customers, deals and projects in Airtable. How do assistants
answer from it, with citations and permissions, under the rules of
ADR 0015?

The options were:

- A. sync chosen bases as indexed, cited documents, like Notion;
- B. live lookups through a capability;
- C. writes with approval.

The decision is **A first**. B and C come later and are not built here.

## Decisions

### 1. An organization connection, like Notion

- `AirtableProvider` (`packages/connectors/src/oauth.ts`) is an OAuth
  provider with scope `organization`. Only an admin connects it, and the
  connection belongs to `@organization`.
- The generic Connect, callback and disconnect
  (`connections.controller.ts`) are reused unchanged. They provide the
  single-use state, the SameSite=Lax browser nonce, the admin re-check at
  callback time, sealing and the audit.
- Airtable's flow:
  - authorize at `https://airtable.com/oauth2/v1/authorize`, token at
    `https://airtable.com/oauth2/v1/token`;
  - **PKCE S256 is required**, and our 43-character state fits Airtable's
    16 to 1024;
  - the client authenticates with **HTTP Basic** (confidential client);
  - redirect `<PUBLIC_ORIGIN>/api/connections/airtable/callback`, built the
    same way as Google's and Notion's.
- **Scopes:** `data.records:read` and `schema.bases:read`, nothing else. A
  grant without both is refused, and the callback shows "missing_scope".
- **Which bases:** the admin picks bases, or a whole workspace, on
  Airtable's consent screen. The platform sees nothing else.
- **Account label:** the granted bases' names (`GET /v0/meta/bases`), so
  the card shows what is connected.
- **Disconnect** removes the stored tokens. Airtable has no revocation
  endpoint, so the grant is also removed in Airtable under Account →
  Third-party integrations (the response says `revokedAtProvider: false`).

### 2. Rotating refresh tokens, serialised

- Access tokens last 60 minutes. Each refresh returns a **new refresh token
  and invalidates the old pair**.
- If the API and the worker both refreshed with the same refresh token, one
  of them would get a dead pair and might save it over the good one. The
  connection would then break until an admin reconnects.
- So `airtableTokenResolver` refreshes inside
  `PersonalConnectionStore.update`:
  - In the database, the row is held with `SELECT … FOR UPDATE` in a
    transaction (`connections.withRowLock`). The new pair is written in the
    same transaction.
  - Whoever gets the lock second re-reads, finds a fresh token and uses it.
    It never refreshes with a spent refresh token.
  - In one process, calls are also chained in memory.
- **409** from the token endpoint means "this refresh token was used a
  moment ago": someone refreshed outside the lock, for example a process
  that died before saving. The resolver then re-reads the stored tokens a
  few times, 2 seconds apart, and does not fail at once. If nothing fresh
  appears, the run fails with "refreshed elsewhere"; the next run tries
  again.
- The lock is held during one HTTP call to Airtable, with a 15-second
  timeout, once an hour at most.

### 3. One document per record

`AirtableSourceAdapter` (`packages/knowledge/src/ingestion/airtable-source.ts`):

- **Listing:** granted bases (`/v0/meta/bases`, paged) → each base's tables
  and fields (`/v0/meta/bases/{id}/tables`) → every record
  (`/v0/{base}/{table}`, 100 per page, `offset`, `returnFieldsByFieldId`,
  so a renamed field doesn't break anything).
- **Document:**
  - title = the primary field's value, or the record id when it is empty;
  - text = `# title`, the base and table, then one `Field: value` line per
    non-empty field in the table's field order;
  - URL = `https://airtable.com/{base}/{table}/{record}`, used for the
    citation link.
- **Cell types:**
  - linked records show their primary value when the linked table was
    listed in the same run, and the record id otherwise (no extra
    requests);
  - attachments are shown by file name only, never downloaded, and their
    expiring URLs are never stored;
  - checkboxes show "Yes"; collaborators show their name; selects,
    numbers, dates, lookups and rollups show their text.
- **External id:** `{baseId}:{recordId}`. The document id is
  `airtable:{baseId}:{recordId}`.
- **The content comes with the listing:** `fetchContent` makes no request.

### 4. Change tracking without "modified since"

- Airtable has no modified-since filter, so every run lists every record.
- **Version:** a SHA-256 of the record's rendered text plus the converter
  tag (`…|at1`). Only records whose text changed are re-indexed.
  - The text includes linked records' primary values, so renaming a
    customer re-indexes the deals that link to it.
  - Attachment URLs are not in the text, so re-signed URLs change nothing.
  - Bump the tag when the rendering changes.
- **Deletion:** a record missing from a complete listing is tombstoned. A
  listing cut short by `maxRecords` (default 20,000) is not complete and
  deletes nothing.
- **Not connected** (or disconnected): an empty, complete listing, so
  every record is removed from the index.

### 5. Rate limits and errors

- At most **5 requests per second per base**: one request per base every
  210 ms. The meta listing is throttled on its own key.
- **429:** wait 30 seconds, then retry, up to 3 times. After that the run
  fails, and the index stays as it was.
- **422 `LIST_RECORDS_ITERATOR_NOT_AVAILABLE`:** that table's listing
  restarts from its first page, up to 3 times, without duplicates. Any
  other 422 is an error.
- **401:** "an admin needs to connect Airtable again".
- The access token is resolved for every request, so a run longer than an
  hour refreshes on the way.

### 6. Permissions

- Airtable doesn't tell this API who may see a base. So every record of a
  granted base gets native groups that the source's `aclMap` maps to the
  platform groups in `AIRTABLE_ACL_GROUPS` (default `all-staff`).
- `AIRTABLE_BASE_ACL_GROUPS` gives particular bases their own groups
  *instead*. It is JSON, for example `{"appXXXXXXXXXXXXXX": ["finance-legal"]}`.
- Unmapped groups drop out, so a record nobody may read is unsearchable
  (fail closed).
- Only admins connect, because every granted base becomes readable by those
  groups.

### 7. Registered like Notion

- Source id `airtable`, kind `airtable`. It is added to the default
  sources when `AIRTABLE_CLIENT_ID` is set.
- The worker's `adapterOptions` gives the source the connection resolver,
  so scheduled ingestion, **Sync now** and the sync after a (dis)connect all
  work as they do for Notion.
- The source id is in the project and meeting assistants' knowledge scopes
  and in the LightRAG partitions' source lists. The Knowledge Assistant
  searches all sources.
- **Egress:** `airtable.com` (token endpoint) and `api.airtable.com` are on
  the proxy's allowlist in the SaaS and Gemini overlays.

## Evidence

- `packages/connectors/test/airtable.test.ts` covers the authorize URL
  (PKCE S256, scopes, state length), the single-use code with Basic auth and
  the verifier, refusal of a grant missing a scope, rotation, two processes
  refreshing at once (one refresh, the same token), a 409 followed by a
  re-read, and giving up.
- `packages/knowledge/test/airtable.test.ts` runs against a fake Airtable
  API. It covers paging of bases and records, the text format, cell types,
  versions (unchanged on re-signed URLs, changed on edits and on linked
  renames), a 429 wait and retry, repeated 429s, the 422 restart without
  duplicates, other 422s, the per-base rate, `maxRecords`, and 401. Through
  the pipeline it covers groups with a per-base override, re-indexing only
  changed records, tombstoning deleted ones, and removal on disconnect.
- `apps/api/test/api.test.ts` (PGlite, the real schema) covers admin-only
  connect, missing scope, the full Connect round trip with a sync request
  and no tokens in the audit, the row-locked refresh from two stores, and
  disconnect.
- `packages/security/test/config.test.ts` covers the configuration
  validation.

## Not verified yet

- Against the real Airtable API with a registered integration. The fake
  follows the documented shapes and behaviours, including rotation and 409,
  but it is not Airtable.
- The exact 422 body for an expired iterator. The adapter accepts both
  `{"error": {"type": …}}` and `{"error": "…"}`.
- The Docker path through `egress-proxy` to `airtable.com` and
  `api.airtable.com`.

## Limits and follow-ups

- **One Airtable connection and one default access level per deployment.**
  Per-base overrides cover different audiences within one connection.
- **Every run reads every record.** That is fine for thousands of records,
  slow for hundreds of thousands. Webhooks (`/v0/bases/{id}/webhooks`) could
  make it incremental later.
- **Linked records across bases** can't be resolved: Airtable links stay
  within a base anyway.
- **Not built:** record comments (`data.recordComments:read`), live lookups
  (option B) and writes with approval (option C).
