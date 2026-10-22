# ADR 0009 — Source ingestion: thin source adapters, one generic pipeline

Status: accepted (Stage 3a) · Date: 2026-10-22 · Builds on ADR 0003 and ADR 0006

## Question

When the platform connects many systems (file shares, SharePoint, Jira,
wikis), how is their content indexed? One adapter per system, or one generic
mechanism?

## Decision

Both, split at a clear line: **a thin, system-specific source adapter** feeds
**one generic ingestion pipeline**. Live connectors (ADR 0007) and indexing are
separate paths. A system can be live-only, indexed, or both, and this is chosen
per source in configuration.

```text
 per system (thin)                    generic (written once)
┌──────────────────────┐   ┌──────────────────────────────────────────────────────────┐
│ SourceAdapter        │   │ IngestionPipeline                                          │
│  listChanges(cursor) │──▶│ size/type limits → parse by MIME → ACL map → catalog upsert │
│  fetchContent(item)  │   │ → content store → tombstones → cursor + run report          │
│  (native ACL per     │   │ failures → quarantine (never indexed, never searchable)    │
│   item)              │   └───────────────┬──────────────────────────────────────────┘
└──────────────────────┘                   │ catalog + content (PostgreSQL)
                                           ▼
                         RAG sync (generic): LightRAG partitions by access set
                         (syncLightRagPartitions), or another backend adapter
```

### What a source adapter does (and only this)

| Method | Responsibility |
|---|---|
| `listChanges(cursor)` | Upserts and deletes since the cursor, plus a new cursor. A full listing is flagged `full: true` so the pipeline can tombstone anything not seen. |
| `fetchContent(item)` | Raw bytes or text, plus the MIME type. |
| per-item `acl` | Permissions in the **source system's own terms**, e.g. a share group `SHARE\Atlas`. |

These parts are system-specific because they differ fundamentally between
systems: APIs, change tracking (delta tokens, timestamps, full scans) and
especially permission models. Getting permissions wrong leaks data, so they are
never guessed generically.

### What the generic pipeline does

1. **Limits:** maximum size per item, and allowed MIME types.
2. **Parsing by MIME type**, shared across all sources: text and Markdown now;
   HTML with tags stripped; PDF, DOCX and scans are a later parser upgrade.
   Until then they are quarantined with the reason `unsupported type`.
3. **ACL mapping:** each source's configuration maps native groups to platform
   groups.
   - Unmapped native groups are dropped.
   - If nothing maps, the document gets an empty ACL. It is catalogued but
     unsearchable (fail closed) and reported as `unmapped_acl`.
4. **Catalog upsert** (`source_documents`): stable ID `<sourceId>:<externalId>`,
   version, title, URL, ACL groups and revision, content hash.
5. **Content store** (`document_content`): the platform's own copy of the
   parsed text. It feeds the RAG sync and the protected document view, so
   neither depends on the source system or on the RAG backend.
6. **Deletion:** explicit deletes, plus anything missing from a full listing,
   are tombstoned. Access checks hide tombstoned documents immediately; the RAG
   sync purges them physically and confirms each deletion (ADR 0006).
7. **State:** a per-source cursor and the last run report (counts, quarantined,
   errors) in `source_sync_state`. Quarantined items are kept in
   `source_quarantine` with the reason.

The worker runs **ingest, then RAG sync** on a schedule (BullMQ job
`knowledge-ingest`). Durable state is in PostgreSQL; the queue only schedules
the work.

### LightRAG partitions: per access set, not per source

A partition now lists **one or more sources** that share the identical ACL set
(`sourceIds: [...]`). This keeps the container count proportional to distinct
access sets rather than to sources × access sets. Mixing sources inside one
partition is safe because every document in it has exactly the same readers.
The agent's source scope is still enforced: chunks from out-of-scope sources
are dropped before evidence is issued.

### MCP and ingestion

MCP tools are built for an agent's live calls, and rarely expose change feeds
or per-item permissions. An MCP server therefore feeds the live path. Bulk
indexing needs a source adapter, possibly one implemented on top of an MCP
server that does expose changes and ACLs.

## Implemented in this stage

- `SourceAdapter` contract, generic `ingestSource()` pipeline, parsers
  (text, Markdown, HTML), quarantine, cursors and run reports.
- **Fixture source adapter:** the existing synthetic Atlas documents (ACL in
  front matter), now ingested through the same pipeline.
- **Folder source adapter:** a file share with ACL files (`.acl.json`) that
  are inherited by subfolders, native group names, and a full listing on every
  scan. It serves as the template for real adapters (SMB/NFS shares, then
  SharePoint via Graph).
- Synthetic `team-share` source that exercises inheritance, an unmapped
  contractor group and an unsupported PDF.
- Worker `ingest` command and a scheduled ingest → LightRAG sync job.

## Evidence

- `packages/knowledge/test/ingestion.test.ts` uses the real folder adapter on
  a temporary share. It covers:
  - inherited ACLs, unmapped groups, HTML parsing and PDF quarantine
  - idempotency and permission-only changes (no re-index)
  - content changes, deletions, symlinks, broken ACL files and quarantine release
- `apps/api/test/api.test.ts` checks share permissions, quarantine and the
  content-store view over HTTP.
- `scripts/lightrag-live-check.mjs` passed 23/23 on real LightRAG and Ollama
  on 2026-10-22.

## Next adapters (each one adds only the adapter, plus its ACL mapping)

| Source | Change tracking | Permissions | Needs |
|---|---|---|---|
| SharePoint / OneDrive | Graph delta query | Site and item permissions → Entra groups | M365 test tenant (Stage 2) |
| Jira / Confluence | `updated >= cursor` (JQL/CQL) | Project roles, space permissions | Test site and API token |
| SMB file share | Full scan, or change journal | NTFS ACLs → AD groups | Share mount and AD group export |

## Open questions to check later

- How many distinct access sets will the first real source produce? If there
  are many, curate coarser sets, or use a backend with per-document filtering
  (ADR 0006).
- Should PDF and DOCX parsing (and OCR for scans) be self-hosted (Apache Tika,
  docling) or provided by the RAG backend?
- Retention: how long to keep `document_content` and quarantine records after
  a source deletes an item (handoff §3: backups versus online deletion).
