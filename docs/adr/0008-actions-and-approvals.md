# ADR 0008 — Proposals, approvals and execution of external writes

Status: accepted (Stage 1) · Date: 2026-10-21

## Decision

`ActionService` (`packages/actions`) is the only path to an external write.

- **States:** `pending_approval → approved → executing → succeeded | failed | unknown`,
  plus `rejected`, `expired`, and `unknown → succeeded` (reconciled).
  Every transition is a conditional `UPDATE … WHERE state = …` inside a transaction.
- **Propose** (runtime only): the input is validated by the capability schema,
  and the principal must hold the capability's groups.
  - The complete connector arguments, including a fresh idempotency key and
    the author, are stored as `payload`.
  - The payload hash is canonical SHA-256 over: customer, principal,
    operation, capability version, connector, tool, payload, policy version
    and expiry.
  - Default TTL is 30 minutes (`ACTION_PROPOSAL_TTL_MINUTES`).
- **Approve** (an authenticated user, CSRF-protected): only the proposer can
  approve. The pilot rule is "the user approves their own action". The
  request must carry the exact payload hash that was displayed.
  - Refused (409) when the stored payload fails its integrity check, the hash
    differs, the proposal is past its expiry, the policy version changed, or
    the proposal is not pending.
  - The approval row and the `action.execute` outbox event commit in the same
    transaction.
- **Execute** (worker; the outbox is leased with `FOR UPDATE SKIP LOCKED`):
  - An atomic claim `approved → executing` means concurrent workers and
    duplicate deliveries execute at most once.
  - Before calling the connector, the worker reloads the proposal, re-checks
    the hash, the approval window, the capability version, the principal's
    current groups and connector availability.
  - The provider's idempotency key is honored by the tracker.
- **Uncertain outcomes**: a write timeout or lost response becomes
  `unknown` (never retried) and enqueues `action.reconcile`. The tracker
  binding looks the comment up by idempotency key and moves the action to
  `succeeded` with a receipt. If the write can't be found, the action stays
  `unknown` for operator review.
- **Crash recovery**: the worker treats `executing` rows at startup, or rows
  older than 5 minutes, as interrupted, and reconciles them.
- **Audit**: proposed, approved, rejected, succeeded, failed, unknown and
  reconciled events, recorded without message content.

## Evidence

`packages/actions/test/actions.test.ts` runs on real PostgreSQL via PGlite,
against the real MCP tracker over HTTP. It covers:
- execution exactly once
- forged hash, payload modified in storage, wrong user, missing capability
- expiry, policy change, rejected proposal
- privileges revoked after approval
- concurrent claims and duplicate outbox delivery
- lost response, then `unknown`, then reconciliation without re-executing

The API HTTP tests repeat the flow over REST with CSRF.
`scripts/integration-live-check.mjs` repeats it against the running stack,
counting comments in the tracker's own data file.

## Not yet

Editing a proposal (should create a new version), approvers other than the
proposer, per-action risk policies, operator UI for `unknown`, and Microsoft
Graph `email.createDraft` (Stage 2).
