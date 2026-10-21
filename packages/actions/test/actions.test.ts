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
