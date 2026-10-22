/**
 * Durable workflow tests (ADR 0011): real migrations on PGlite, the real
 * synthetic tracker MCP server in-process, the real McpConnector and
 * ActionService. Time is a controllable clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { CapabilityRegistry } from "@platform/agents";
import { ActionService } from "@platform/actions";
import { ConnectorRegistry, fetchMcpToolPins, McpConnector, McpServerConfigSchema, registerAtlasTrackerCapabilities } from "@platform/connectors";
import { createRepositories, schema, seedIdentities, type Database } from "@platform/database";
import { createTestDatabase } from "@platform/database/testing";
import { createTrackerHttpServer, SEED_TASKS, TrackerStore } from "@platform/mcp-atlas-tracker";
import { createTrustedContext, NotFoundOrForbiddenError } from "@platform/security";
import { WorkflowService } from "../src/index.js";

const TOKEN = "test-token-0123456789";
const C = "cust_demo";
const POLICY = "p1";
let db: Database;
let closeDb: () => Promise<void>;
let server: Server;
let store: TrackerStore;
let url: string;
let pins: Record<string, string>;
let clock = new Date("2026-10-22T08:00:00Z");

const ctx = (p: string) => createTrustedContext({ customerId: C, principalId: p, policyVersion: POLICY });
const minutes = (n: number) => (clock = new Date(clock.getTime() + n * 60_000));

function world() {
  const connector = new McpConnector(McpServerConfigSchema.parse({ id: "atlas-tracker", url, pinnedTools: pins, timeoutMs: 5000 }), TOKEN);
  const capabilities = new CapabilityRegistry();
  registerAtlasTrackerCapabilities(capabilities, connector);
  const repos = createRepositories(db);
  const actions = new ActionService({ db, capabilities, connectors: new ConnectorRegistry([connector]), principals: repos.principals, audit: repos.audit, now: () => clock });
  const workflows = new WorkflowService({ db, capabilities, actions, principals: repos.principals, audit: repos.audit, policyVersion: POLICY, now: () => clock, staleMs: 5 * 60_000 });
  return { actions, workflows, repos };
}

const proposalsFor = async (workflowRunIds?: string[]) => {
  const rows = await db.select().from(schema.actionProposals);
  return workflowRunIds ? rows.filter((r) => r.runId && workflowRunIds.includes(r.runId)) : rows.filter((r) => r.dedupeKey?.startsWith("wf:"));
};

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDatabase());
  await seedIdentities(db, { id: C, name: "Demo" }, [
    { principalId: "alice", displayName: "Alice", description: "", groups: ["atlas-team"], roles: [] },
    { principalId: "bob", displayName: "Bob", description: "", groups: ["all-staff"], roles: [] },
  ]);
  store = await new TrackerStore().load();
  server = createTrackerHttpServer({ store, token: TOKEN });
  url = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  pins = Object.fromEntries((await fetchMcpToolPins(url, TOKEN)).map((t) => [t.name, t.sha256]));
});
afterAll(async () => {
  server?.close();
  await closeDb?.();
});
beforeEach(async () => {
  await db.delete(schema.workflowRuns);
  await db.delete(schema.workflows);
  await db.delete(schema.outboxEvents);
  await db.delete(schema.executionAttempts);
  await db.delete(schema.approvals);
  await db.delete(schema.actionProposals);
  await createRepositories(db).principals.setGroups(C, "alice", ["atlas-team"]);
  for (const t of SEED_TASKS) await store.setStatus(t.key, t.status);
});

describe("WorkflowService", () => {
  it("creates a workflow only for an owner who holds its capabilities", async () => {
    const { workflows } = world();
    await expect(workflows.create(ctx("bob"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 })).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
    await expect(workflows.create(ctx("alice"), { kind: "nope", config: {}, intervalMinutes: 60 })).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
    await expect(workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "../etc" }, intervalMinutes: 60 })).rejects.toThrow();
    const w = await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    expect(w).toMatchObject({ title: "Tracker status check · ATLAS", enabled: true, config: { project: "ATLAS", watchStatuses: ["Blocked", "At risk"] } });
    expect(await workflows.list(ctx("bob"))).toEqual([]);
    await expect(workflows.runs(ctx("bob"), w.id)).rejects.toBeInstanceOf(NotFoundOrForbiddenError);
  });

  it("first run proposes one comment per watched task; unchanged later runs propose nothing", async () => {
    const { workflows } = world();
    const w = await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    expect(await workflows.tick()).toEqual({ dispatched: 1, succeeded: 1, failed: 0 });
    const [run] = await workflows.runs(ctx("alice"), w.id);
    expect(run!.result).toMatchObject({ project: "ATLAS", checked: 4, proposals: [{ taskKey: "ATLAS-180" }] });
    expect(run!.result).not.toHaveProperty("snapshot"); // internal state stays out of the view
    expect(await proposalsFor()).toHaveLength(1);

    minutes(30);
    expect(await workflows.tick()).toEqual({ dispatched: 0, succeeded: 0, failed: 0 }); // not due yet
    minutes(31);
    expect((await workflows.tick()).succeeded).toBe(1);
    expect(await proposalsFor()).toHaveLength(1);
  });

  it("proposes again only when a task newly enters a watched status", async () => {
    const { workflows } = world();
    const w = await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    await workflows.tick();
    await store.setStatus("ATLAS-171", "Blocked");
    minutes(61);
    await workflows.tick();
    const [latest] = await workflows.runs(ctx("alice"), w.id);
    expect(latest!.result).toMatchObject({ changes: [{ taskKey: "ATLAS-171", from: "In progress", to: "Blocked" }], proposals: [{ taskKey: "ATLAS-171" }] });
    const all = await proposalsFor();
    expect(all.map((p) => (p.payload as { taskKey: string }).taskKey).sort()).toEqual(["ATLAS-171", "ATLAS-180"]);
    expect(String((all.find((p) => (p.payload as { taskKey: string }).taskKey === "ATLAS-171")!.payload as { text: string }).text)).toContain('was "In progress"');
  });

  it("duplicate dispatch and redelivery create no second run for the same slot", async () => {
    const { workflows } = world();
    const w = await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    const [a, b] = await Promise.all([workflows.dispatchDue(), workflows.dispatchDue()]);
    expect(a!.length + b!.length).toBe(1);
    // A redelivered slot (same workflow + scheduledFor) is rejected by the unique key.
    const [run] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, w.id));
    await db.insert(schema.workflowRuns).values({ workflowId: w.id, customerId: C, scheduledFor: run!.scheduledFor }).onConflictDoNothing();
    expect(await db.select().from(schema.workflowRuns)).toHaveLength(1);
  });

  it("two workers executing the same run: exactly one runs it", async () => {
    const { workflows } = world();
    await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    const [id] = await workflows.dispatchDue();
    const results = await Promise.all([workflows.execute(id!), workflows.execute(id!)]);
    expect(results.sort()).toEqual(["skipped", "succeeded"]);
    expect(await proposalsFor()).toHaveLength(1);
  });

  it("a crashed run is taken over after its heartbeat goes stale, without a duplicate proposal", async () => {
    const { workflows } = world();
    const w = await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    const [id] = await workflows.dispatchDue();
    await workflows.execute(id!);
    // Simulate a worker that proposed, then died before recording success.
    await db.update(schema.workflowRuns).set({ status: "running", heartbeatAt: clock, result: null, finishedAt: null }).where(eq(schema.workflowRuns.id, id!));
    expect(await workflows.runnable()).toEqual([]); // heartbeat still fresh: not taken over
    minutes(6);
    expect(await workflows.runnable()).toEqual([id]);
    expect(await workflows.execute(id!)).toBe("succeeded");
    const [run] = await workflows.runs(ctx("alice"), w.id);
    expect(run).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(await proposalsFor()).toHaveLength(1); // dedupe key: same logical write
  });

  it("runs with the owner's CURRENT permissions: revoked access fails the run, proposes nothing", async () => {
    const { workflows, repos } = world();
    const w = await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    await repos.principals.setGroups(C, "alice", ["all-staff"]);
    expect((await workflows.tick()).failed).toBe(1);
    const [run] = await workflows.runs(ctx("alice"), w.id);
    expect(run).toMatchObject({ status: "failed" });
    expect(run!.error).toMatch(/^forbidden/);
    expect(await proposalsFor()).toHaveLength(0);
  });

  it("a workflow proposal is approved and executed like any other write, exactly once", async () => {
    const { workflows, actions } = world();
    await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    await workflows.tick();
    const [p] = await proposalsFor();
    const view = await actions.approve(ctx("alice"), p!.id, p!.payloadHash);
    expect(view.state).toBe("approved");
    await actions.processOutbox();
    expect((await actions.get(ctx("alice"), p!.id)).state).toBe("succeeded");
    const idem = String((p!.payload as { idempotencyKey: string }).idempotencyKey);
    expect(store.get("ATLAS-180")!.comments.filter((c) => c.idempotencyKey === idem)).toHaveLength(1);
  });

  it("workflow proposals wait 72 hours; approving the comment does not trigger a new proposal", async () => {
    const { workflows, actions } = world();
    await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    await workflows.tick();
    const [p] = await proposalsFor();
    expect(p!.expiresAt.getTime() - clock.getTime()).toBe(72 * 60 * 60_000);
    await actions.approve(ctx("alice"), p!.id, p!.payloadHash);
    await actions.processOutbox(); // posting the comment changes the task's updatedAt
    minutes(61);
    await workflows.tick();
    expect(await proposalsFor()).toHaveLength(1);
  });

  it("re-raises a change whose proposal expired unanswered, once; never one the owner rejected", async () => {
    const { workflows, actions } = world();
    await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    await workflows.tick();
    minutes(73 * 60); // nobody answered for three days
    await workflows.tick();
    const after = await proposalsFor();
    expect(after.filter((r) => r.state === "pending_approval")).toHaveLength(1);
    expect(after.filter((r) => r.state === "expired")).toHaveLength(1);
    minutes(61);
    await workflows.tick();
    expect(await proposalsFor()).toHaveLength(2); // still just the one replacement

    const open = after.find((r) => r.state === "pending_approval")!;
    await actions.reject(ctx("alice"), open.id);
    minutes(80 * 60);
    await workflows.tick();
    expect(await proposalsFor()).toHaveLength(2); // a rejection is final
  });

  it("does not back-fill missed slots after downtime, and paused workflows never run", async () => {
    const { workflows } = world();
    const w = await workflows.create(ctx("alice"), { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 });
    minutes(5 * 60); // worker was down for five intervals
    expect(await workflows.dispatchDue()).toHaveLength(1);
    expect(await workflows.dispatchDue()).toHaveLength(0);
    const [view] = await workflows.list(ctx("alice"));
    expect(new Date(view!.nextRunAt).getTime()).toBeGreaterThan(clock.getTime());

    await workflows.setEnabled(ctx("alice"), w.id, false);
    minutes(120);
    expect(await workflows.dispatchDue()).toHaveLength(0);
    await workflows.runNow(ctx("alice"), w.id); // run-now re-enables and schedules immediately
    expect(await workflows.dispatchDue()).toHaveLength(1);
  });
});
