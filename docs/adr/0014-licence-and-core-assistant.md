# ADR 0014 — Signed licence, entitlements and the core Knowledge Assistant

Status: accepted · Date: 2026-10-23 · Builds on ADR 0007, 0011 and 0012

## Question

The platform is sold as a core (connect sources, ask questions over them)
plus paid agents and workflows built for each customer. How does one
deployment know what it may run, without a call home from an on-premises
install, and what happens when a licence ends?

## Decisions

### 1. A signed licence file, verified offline

- A JSON file, format `platform-licence@1`:
  - `licenceId`, `customerId`, `customerName`
  - `issuedAt`, `expiresAt`, `graceDays` (default 14)
  - `agents`: the add-on agents
  - `workflowKinds`: the workflow kinds
- It is signed with **Ed25519** over the canonical JSON of the licence body
  (keys sorted, as for approval hashes).
- The platform checks it against public keys compiled into
  `packages/security/src/licence.ts` (`TRUSTED_LICENCE_KEYS`). There is no
  network call.
- Startup **fails** (exit 78) for anything that is not a genuine licence for
  this deployment:
  - unreadable, malformed or extra fields
  - unknown key or bad signature (an added agent or a later expiry breaks it)
  - another `CUSTOMER_ID`
  - expiry before issue
- `LICENCE_FILE` selects the file.
  - Production requires it, and refuses the development key.
  - Outside production the default is the committed development licence,
    `fixtures/licence/dev.licence.json`.
- Vendor tool: `scripts/licence.mjs keygen | sign`. Production private keys
  never enter the repository.
- The development private key is committed on purpose, so tests can sign
  licences. That is why production refuses it.

**Limit, stated plainly:** on-premises, the customer runs the code. A
determined customer can patch the check. The licence makes the contract
explicit, visible and audited; it is not DRM.

### 2. Core is always available; add-ons follow the licence

- **Core agents** (`CORE_AGENTS`: `knowledge-assistant`) are available with
  any licence, including an expired one. A customer never loses search over
  their own documents because of a billing issue.
- **Add-on agents and workflow kinds** are available while the licence is
  `valid`, and in `grace` (after expiry, for `graceDays`, with a warning).
  After that they stop (`expired`).
- The licence is checked **on every request**, so expiry takes effect
  without a restart. Changing the file still needs a restart.

### 3. Where it is enforced

| Point | Effect |
|---|---|
| `GET /api/agents` | Lists only entitled agents |
| `POST /api/conversations` | 403 `not_licensed` for an add-on not in the licence |
| Every question (JSON and stream) | 403 `not_licensed`, also in existing conversations |
| `GET /api/workflow-kinds`, `POST /api/workflows` | Lists only entitled kinds; others get 403 |
| Every workflow run (worker) | Fails with `not licensed: workflow …`. No reads, no proposals. The workflow is kept and works again once the licence is renewed. |

`not_licensed` is a 403 with a clear message, unlike the 404 used for
permissions: it is about the deployment, not the user, so it reveals
nothing.

### 4. The core Knowledge Assistant

- A new agent, `agents/knowledge-assistant`, and only a definition:
  `knowledge.search` over every configured source, with no live tools and
  no writes.
- Its instructions say that it cannot see live systems: for a status
  question, it answers from the latest document and says that this may be
  out of date.
- The Project Assistant and Meeting Preparation are now the paid add-ons.
  They are unchanged.

### 5. Admin

- **Agents tab:** a licence panel shows the status, days left, customer,
  licence id, expiry and workflow kinds. Each agent is marked **core**,
  **licensed** or **not licensed**.
- **Overview:** shows a warning when the licence expires within 30 days, is
  in grace, has expired, or is missing.
- `GET /api/admin/licence` returns the summary, never the signature.
- The API logs the licence id and status at startup.

## Evidence

- `packages/security/test/licence.test.ts`:
  - the committed licence, signed by the script, verifies
  - tampering, an extended expiry, a forged key id and an unknown key are
    all rejected
  - production refuses the development key
  - wrong customer, malformed files and impossible dates are rejected
  - the status moves from valid to grace to expired
  - core agents survive expiry
- `agents/knowledge-assistant/test/evals.test.ts`: with the tracker and
  calendar registered, the model is offered only `knowledge.search`, and
  nothing is read live or proposed. It answers in English and Bulgarian,
  and the denied user gets nothing.
- `apps/api/test/api.test.ts`, "licence and entitlements":
  - with the core-only licence, add-ons are hidden and refused, including in
    existing conversations
  - the Knowledge Assistant still answers
  - workflows are refused
  - an expired licence falls back to core, and the admin overview reports it
  - a licence for another customer stops startup
- `packages/workflows/test/workflows.test.ts`: a run under an expired
  licence fails with no proposals.
- Checked in the browser (local dev servers, English and Bulgarian): the
  admin licence panel and the Knowledge Assistant in the chat sidebar.

## Not done

- No production signing key yet. Generate one at the first release
  (`scripts/licence.mjs keygen`), keep the private key in the vendor's
  secret store, and add the public key to `TRUSTED_LICENCE_KEYS`.
- No seat or usage limits. The format can add fields under a new `format`
  version.
- No hot reload of the file: renewing means replacing the file and
  restarting the API and the worker.
