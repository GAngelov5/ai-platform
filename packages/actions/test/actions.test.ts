/**
 * Action gateway tests (handoff §5): real migrations on PGlite, the real
 * atlas-tracker MCP server in-process, the real McpConnector.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { CapabilityRegistry } from "@platform/agents";
import { ConnectorRegistry, fetchMcpToolPins, McpConnector, McpServerConfigSchema, registerAtlasTrackerCapabilities } from "@platform/connectors";
import { createRepositories, schema, seedIdentities, type Database } from "@platform/database";
import { createTestDatabase } from "@platform/database/testing";
import { createTrackerHttpServer, TrackerStore } from "@platform/mcp-atlas-tracker";
import { createTrustedContext, NotFoundOrForbiddenError } from "@platform/security";
import { ActionConflictError, ActionService } from "../src/index.js";

const TOKEN = "test-token-0123456789";
const C = "cust_demo";
let db: Database;
let closeDb: () => Promise<void>;
let store: TrackerStore;
const servers: Server[] = [];
let fastUrl: string;
let slowUrl: string;
let pins: Record<string, string>;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`)));
const ctx = (p: string, policyVersion = "p1") => createTrustedContext({ customerId: C, principalId: p, policyVersion });

function service(url = fastUrl, opts: { timeoutMs?: number; now?: () => Date } = {}) {
  const connector = new McpConnector(McpServerConfigSchema.parse({ id: "atlas-tracker", url, pinnedTools: pins, timeoutMs: opts.timeoutMs ?? 5000 }), TOKEN);
  const capabilities = new CapabilityRegistry();
  registerAtlasTrackerCapabilities(capabilities, connector);
  const repos = createRepositories(db);
  return {
    connector,
    svc: new ActionService({ db, capabilities, connectors: new ConnectorRegistry([connector]), principals: repos.principals, audit: repos.audit, now: opts.now }),
  };
}

const comments = (key: string) => store.get("ATLAS-180")!.comments.filter((c) => c.idempotencyKey === key);

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDatabase());
  await seedIdentities(db, { id: C, name: "Demo" }, [
    { principalId: "alice", displayName: "Alice", description: "", groups: ["atlas-team"], roles: [] },
    { principalId: "bob", displayName: "Bob", description: "", groups: ["all-staff"], roles: [] },
    { principalId: "carol", displayName: "Carol", description: "", groups: ["atlas-team"], roles: [] },
  ]);
  store = await new TrackerStore().load();
  const fast = createTrackerHttpServer({ store, token: TOKEN });
  const slow = createTrackerHttpServer({ store, token: TOKEN, postCommitDelayMs: 1200 });
  servers.push(fast, slow);
  fastUrl = await listen(fast);
  slowUrl = await listen(slow);
  pins = Object.fromEntries((await fetchMcpToolPins(fastUrl, TOKEN)).map((t) => [t.name, t.sha256]));
});
afterAll(async () => {
  servers.forEach((s) => s.close());
  await closeDb?.();
});
beforeEach(async () => {
  await createRepositories(db).principals.setGroups(C, "alice", ["atlas-team"]);
});

const propose = (svc: ActionService, text = "Readiness review moved to 3 November.") =>
  svc.propose(ctx("alice"), { capabilityId: "tracker.task.comment", input: { taskKey: "ATLAS-180", text } });

describe("ActionService", () => {
  it("executes an approved proposal exactly once via the outbox", async () => {
    const { svc } = service();
    const p = await propose(svc);
    expect(p.state).toBe("pending_approval");
    expect(p.payload).toMatchObject({ taskKey: "ATLAS-180", author: "Alice" });
    expect(comments(String(p.payload.idempotencyKey))).toHaveLength(0); // proposing never executes
    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    expect(await svc.processOutbox()).toBeGreaterThan(0);
    const done = await svc.get(ctx("alice"), p.id);
    expect(done.state).toBe("succeeded");
    expect(done.receipt).toMatchObject({ created: true });
    expect(comments(String(p.payload.idempotencyKey))).toHaveLength(1);
  });

  it("rejects a forged or changed payload hash", async () => {
    const { svc } = service();
    const p = await propose(svc);
    await expect(svc.approve(ctx("alice"), p.id, "f".repeat(64))).rejects.toMatchObject({ reason: "payload_mismatch" });
    expect((await svc.get(ctx("alice"), p.id)).state).toBe("pending_approval");
  });

  it("detects a payload modified in storage after proposal", async () => {
    const { svc } = service();
    const p = await propose(svc);
    await db.update(schema.actionProposals).set({ payload: { ...p.payload, text: "Go-live approved!" } }).where(eq(schema.actionProposals.id, p.id));
    await expect(svc.approve(ctx("alice"), p.id, p.payloadHash)).rejects.toMatchObject({ reason: "payload_mismatch" });
  });

  it("does not let another user see or approve the proposal", async () => {
    const { svc } = service();
    const p = await propose(svc);
    await expect(svc.approve(ctx("carol"), p.id, p.payloadHash)).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
    await expect(svc.get(ctx("bob"), p.id)).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
  });

  it("refuses proposals from principals without the capability", async () => {
    const { svc } = service();
    await expect(svc.propose(ctx("bob"), { capabilityId: "tracker.task.comment", input: { taskKey: "ATLAS-180", text: "x" } })).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
  });

  it("rejects expired proposals and policy changes", async () => {
    let now = new Date();
    const { svc } = service(fastUrl, { now: () => now });
    const p = await propose(svc);
    await expect(svc.approve(ctx("alice", "p2"), p.id, p.payloadHash)).rejects.toMatchObject({ reason: "policy_changed" });
    now = new Date(now.getTime() + 31 * 60_000);
    await expect(svc.approve(ctx("alice"), p.id, p.payloadHash)).rejects.toMatchObject({ reason: "expired" });
    expect((await svc.get(ctx("alice"), p.id)).state).toBe("expired");
  });

  it("re-authorizes at execution: revoked privileges fail closed", async () => {
    const { svc } = service();
    const p = await propose(svc);
    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    await createRepositories(db).principals.setGroups(C, "alice", ["all-staff"]);
    expect(await svc.executeApproved(p.id)).toBe("failed");
    expect((await svc.get(ctx("alice"), p.id)).lastError).toMatch(/no longer authorized/);
    expect(comments(String(p.payload.idempotencyKey))).toHaveLength(0);
  });

  it("concurrent claims and duplicate deliveries execute once", async () => {
    const { svc } = service();
    const p = await propose(svc);
    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    const outcomes = await Promise.all([svc.executeApproved(p.id), svc.executeApproved(p.id), svc.executeApproved(p.id)]);
    expect(outcomes.filter((o) => o === "succeeded")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(2);
    // Redeliver the outbox event: still one execution.
    await db.update(schema.outboxEvents).set({ processedAt: null, availableAt: new Date(0) }).where(eq(schema.outboxEvents.aggregateId, p.id));
    await svc.processOutbox();
    expect(comments(String(p.payload.idempotencyKey))).toHaveLength(1);
  });

  it("a lost response after provider success becomes unknown, then reconciles without re-executing", async () => {
    const { svc } = service(slowUrl, { timeoutMs: 500 });
    const p = await propose(svc);
    await svc.approve(ctx("alice"), p.id, p.payloadHash);
    expect(await svc.executeApproved(p.id)).toBe("unknown");
    await new Promise((r) => setTimeout(r, 1000)); // provider finishes the write
    const fast = service().svc;
    expect(await fast.reconcile(p.id)).toBe("reconciled");
    const v = await fast.get(ctx("alice"), p.id);
    expect(v.state).toBe("succeeded");
    expect(v.receipt).toMatchObject({ reconciled: true });
    expect(comments(String(p.payload.idempotencyKey))).toHaveLength(1);
  });

  it("rejected proposals can never be approved", async () => {
    const { svc } = service();
    const p = await propose(svc);
    await svc.reject(ctx("alice"), p.id);
    await expect(svc.approve(ctx("alice"), p.id, p.payloadHash)).rejects.toBeInstanceOf(ActionConflictError);
  });
});

describe("deduplicated proposals (automated proposers)", () => {
  let clock: Date;
  const make = () => service(fastUrl, { now: () => clock }).svc;
  const once = (svc: ActionService, key: string, extra: { ttlMs?: number; policyVersion?: string } = {}) =>
    svc.proposeOnce(ctx("alice", extra.policyVersion), {
      capabilityId: "tracker.task.comment",
      input: { taskKey: "ATLAS-180", text: "Status check" },
      dedupeKey: key,
      ttlMs: extra.ttlMs,
    });
  const rows = (key: string) => db.select().from(schema.actionProposals).then((r) => r.filter((x) => x.dedupeKey?.startsWith(key)));
  beforeEach(() => {
    clock = new Date("2026-10-22T08:00:00Z");
  });

  it("returns the same proposal while it can be decided", async () => {
    const svc = make();
    const a = await once(svc, "k-same");
    const b = await once(svc, "k-same");
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, proposal: { id: a.proposal.id } });
  });

  it("replaces a proposal that expired unanswered, keeping the old one as history", async () => {
    const svc = make();
    const a = await once(svc, "k-exp", { ttlMs: 60 * 60_000 });
    clock = new Date(clock.getTime() + 61 * 60_000);
    const b = await once(svc, "k-exp");
    expect(b.created).toBe(true);
    expect(b.proposal.id).not.toBe(a.proposal.id);
    const all = await rows("k-exp");
    expect(all.find((r) => r.id === a.proposal.id)).toMatchObject({ state: "expired", dedupeKey: `k-exp#retired:${a.proposal.id}` });
    expect(all.filter((r) => r.state === "pending_approval")).toHaveLength(1);
  });

  it("replaces a proposal made under an older policy version (it could no longer be approved)", async () => {
    const svc = make();
    const a = await once(svc, "k-pol");
    const b = await once(svc, "k-pol", { policyVersion: "p2" });
    expect(b.created).toBe(true);
    expect(b.proposal.id).not.toBe(a.proposal.id);
  });

  it("never re-raises a proposal the user rejected or approved", async () => {
    const svc = make();
    const a = await once(svc, "k-rej");
    await svc.reject(ctx("alice"), a.proposal.id);
    clock = new Date(clock.getTime() + 8 * 24 * 60 * 60_000);
    expect(await once(svc, "k-rej")).toMatchObject({ created: false, proposal: { id: a.proposal.id, state: "rejected" } });

    const c = await once(svc, "k-app");
    await svc.approve(ctx("alice"), c.proposal.id, c.proposal.payloadHash);
    expect(await once(svc, "k-app")).toMatchObject({ created: false, proposal: { id: c.proposal.id } });
  });

  it("concurrent first proposals with one key create exactly one", async () => {
    const svc = make();
    const r = await Promise.all([once(svc, "k-race"), once(svc, "k-race"), once(svc, "k-race")]);
    expect(new Set(r.map((x) => x.proposal.id)).size).toBe(1);
    expect(r.filter((x) => x.created)).toHaveLength(1);
  });

  it("bounds the requested lifetime to 7 days", async () => {
    const svc = make();
    const a = await once(svc, "k-ttl", { ttlMs: 30 * 24 * 60 * 60_000 });
    expect(new Date(a.proposal.expiresAt).getTime() - clock.getTime()).toBe(7 * 24 * 60 * 60_000);
  });
});
