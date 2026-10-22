# ADR 0012 — Admin console: operational metadata, never content

Status: accepted · Date: 2026-10-22 · Builds on ADR 0002, 0008, 0009 and 0011

## Question

Operators need to run the platform without SQL: see sync status and
quarantine, check integrations and tool pins, resolve actions with an
unknown outcome, watch workflows, and read the audit log. How do we give
them that without making "admin" a back door to company data?

## Decision

### Separation of duties: administration is not document access

- A separate **`admin` role**, held by a principal, and re-read from storage
  on every request. The synthetic operator is **Dana**: all-staff groups only,
  plus `admin`.
- The admin role grants **no document access**. Dana searches and asks with
  her own groups, exactly like anyone else.
- Admin routes (`/api/admin/*`, guarded by `@AdminOnly()`) return
  **operational metadata only**: counts, titles, item paths, states, errors,
  timestamps, health, tool pins and audit metadata. They never return
  document text, excerpts, messages, answers, or proposal payload *values*.
  Actions show their field names and the approved hash only.
- **Non-admins get 404**, as for a resource that doesn't exist, and every
  denial is audited (`admin.access`, outcome `denied`).
- **Admin changes are audited:** `admin.source.sync_requested` and
  `admin.action.reconcile`.

### Views

| Tab | Shows | Operator actions |
|---|---|---|
| Overview | Health of knowledge, model and connectors (real probes); attention counters: unknown or failed actions, quarantine, source errors, failing or stuck workflows, denied events; usage | — |
| Sources | Per source: documents, indexed in RAG, unsearchable (no mapped group), quarantined, last run report | **Sync now**; view quarantine (item, reason, detail) |
| Integrations | Per connector: health, each pinned tool (enabled, or why not, e.g. a pin mismatch), capabilities with kind and allowed groups | — |
| Agents | Registered agents: capabilities, knowledge sources, limits | — |
| Actions | All users' proposals: state, origin (conversation or workflow), attempts, errors; filter by state | **Reconcile** an `unknown` action by its idempotency key (never re-executes) |
| Workflows | All workflows: owner, kind, schedule, last run, failures in 24 h | — |
| Audit | Audit events, filtered by action prefix, principal and outcome | — |

### "Sync now" is a request, not a command

The API records `sync_requested_at` on the source's sync state (migration
0004). The worker's `sync-requests` job (every minute) then:
1. ingests the requested sources and syncs the RAG backend, under the
   indexing lock
2. clears only the requests made before it started, so a click during a run
   isn't lost

The API needs no queue connection and no source credentials.

## Evidence

`apps/api/test/api.test.ts`, "admin console", 4 tests:
- 404 for every admin route as a non-admin, with the denial audited
- admin views work, and the admin still can't find Atlas documents
- across every admin route, no comment text, restricted memo canary or
  document body sentence appears
- Sync now needs CSRF, records the request, and its clearing works

## Not in this stage

- **Entitlements and licensing:** which agents and workflow kinds a customer
  has licensed. Planned next to the Agents tab.
- **Editing configuration from the UI:** sources, group mappings, MCP pins.
  These stay deployment configuration under change control for now. Pins in
  particular should be reviewed in a pull request, not clicked.
- **Pagination beyond the first 100–500 rows,** and audit export.
