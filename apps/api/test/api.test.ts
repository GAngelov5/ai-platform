/**
 * HTTP-level tests: real NestJS app, real migrations on in-process PostgreSQL
 * (PGlite), fixture knowledge adapter and the deterministic FAKE model.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { fileURLToPath } from "node:url";
import { FakeModelGateway } from "@platform/ai";
import { createRepositories, type Database } from "@platform/database";
import { createTestDatabase } from "@platform/database/testing";
import { loadPlatformConfig } from "@platform/security";
import { seedFixtures } from "@platform/worker/seed";
import { createTrackerHttpServer, TrackerStore } from "@platform/mcp-atlas-tracker";
import { fetchMcpToolPins } from "@platform/connectors";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildDeps, createApiApp, createLogger, type PlatformDeps } from "../src/app.js";

const CANARY = "FORBIDDEN-CANARY-7Q4X";
const FIXTURES_ROOT = fileURLToPath(new URL("../../../fixtures", import.meta.url));

class Client {
  readonly cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  async req(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, opts: { csrf?: boolean } = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && opts.csrf !== false && this.cookies.has("platform_csrf")) headers["x-csrf-token"] = this.cookies.get("platform_csrf")!;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      const v = kv!.slice(i + 1);
      if (v === "" || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(kv!.slice(0, i));
      else this.cookies.set(kv!.slice(0, i), v);
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined; // e.g. text/event-stream
    }
    return { status: res.status, text, json };
  }

  async login(principalId: string) {
    await this.req("GET", "/api/auth/csrf");
    const r = await this.req("POST", "/api/auth/dev-login", { principalId });
    expect(r.status).toBe(200);
    return this;
  }
}

let app: INestApplication;
let base: string;
let db: Database;
let close: () => Promise<void>;
let model: FakeModelGateway;
let deps: PlatformDeps;
let tracker: Server;
let trackerStore: TrackerStore;
let mcpEnv: Record<string, string> = {};
const MCP_TOKEN = "tracker-test-token-0123456789";

async function boot(env: Record<string, string>) {
  const all = { APP_ENV: "test", DEV_AUTH_ENABLED: "true", LOG_LEVEL: "fatal", ...mcpEnv, ...env };
  const config = loadPlatformConfig(all);
  model = new FakeModelGateway();
  const d = await buildDeps({ config, db, logger: createLogger("fatal"), pingDatabase: async () => {}, model, secret: (n) => all[n as keyof typeof all] });
  const a = await createApiApp(d);
  await a.listen(0, "127.0.0.1");
  return { app: a, deps: d, base: (await a.getUrl()).replace("[::1]", "127.0.0.1") };
}

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  await seedFixtures(db, FIXTURES_ROOT, "cust_demo");
  trackerStore = await new TrackerStore().load();
  tracker = createTrackerHttpServer({ store: trackerStore, token: MCP_TOKEN });
  const url = await new Promise<string>((r) => tracker.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(tracker.address() as AddressInfo).port}/mcp`)));
  const pins = Object.fromEntries((await fetchMcpToolPins(url, MCP_TOKEN)).map((t) => [t.name, t.sha256]));
  mcpEnv = { MCP_SERVERS: JSON.stringify([{ id: "atlas-tracker", url, pinnedTools: pins }]), MCP_TOKEN_ATLAS_TRACKER: MCP_TOKEN };
  ({ app, base, deps } = await boot({ LOG_LEVEL: "fatal" }));
});

afterAll(async () => {
  await app?.close();
  await deps?.connectors.closeAll();
  tracker?.close();
  await close?.();
});

const as = (p: string) => new Client(base).login(p);
const ask = async (c: Client, question: string) => {
  const conv = await c.req("POST", "/api/conversations", { agentId: "project-assistant" });
  expect(conv.status).toBe(201);
  const r = await c.req("POST", `/api/conversations/${conv.json.id}/messages`, { content: question });
  expect(r.status).toBe(201);
  return { conversationId: conv.json.id as string, answer: r.json.assistantMessage };
};

describe("health and readiness", () => {
  it("is live and ready without authentication", async () => {
    const c = new Client(base);
    expect((await c.req("GET", "/api/health")).json).toEqual({ status: "ok" });
    const ready = await c.req("GET", "/api/ready");
    expect(ready.status).toBe(200);
    expect(ready.json.status).toBe("ready");
  });
});

describe("authentication and forged identity", () => {
  it("rejects unauthenticated access even with identity headers", async () => {
    const c = new Client(base);
    await c.req("GET", "/api/auth/csrf");
    const r = await c.req("POST", "/api/knowledge/search", { query: "Atlas" }, { "x-principal-id": "alice", "x-customer-id": "cust_demo" });
    expect(r.status).toBe(401);
  });

  it("ignores identity headers and rejects identity fields in bodies", async () => {
    const bob = await as("bob");
    const viaHeader = await bob.req("POST", "/api/knowledge/search", { query: "Why was Project Atlas delayed?" }, { "x-principal-id": "alice" });
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.json.evidence).toEqual([]);
    const viaBody = await bob.req("POST", "/api/knowledge/search", { query: "Atlas", principalId: "alice" });
    expect(viaBody.status).toBe(400);
    expect(viaBody.text).not.toContain("alice");
    expect((await bob.req("GET", "/api/auth/me")).json.principalId).toBe("bob");
  });

  it("rejects forged session cookies and unknown dev principals", async () => {
    const c = new Client(base);
    const r = await fetch(`${base}/api/auth/me`, { headers: { cookie: "platform_session=forged-token-value" } });
    expect(r.status).toBe(401);
    await c.req("GET", "/api/auth/csrf");
    expect((await c.req("POST", "/api/auth/dev-login", { principalId: "mallory" })).status).toBe(401);
  });

  it("requires a CSRF token for cookie-authenticated mutations", async () => {
    const alice = await as("alice");
    expect((await alice.req("POST", "/api/conversations", { agentId: "project-assistant" }, {}, { csrf: false })).status).toBe(403);
    const crossOrigin = await alice.req("POST", "/api/conversations", { agentId: "project-assistant" }, { origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);
  });

  it("logout revokes the session server-side", async () => {
    const alice = await as("alice");
    expect((await alice.req("POST", "/api/auth/logout")).status).toBe(204);
    expect((await alice.req("GET", "/api/auth/me")).status).toBe(401);
  });
});

describe("knowledge search and protected documents", () => {
  it("returns permitted evidence and no forbidden content", async () => {
    const alice = await as("alice");
    const r = await alice.req("POST", "/api/knowledge/search", { query: "Why was Project Atlas delayed?", limit: 10 });
    expect(r.status).toBe(200);
    const docs = r.json.evidence.map((e: { documentId: string }) => e.documentId);
    expect(docs).toContain("atlas-status-2026-04");
    expect(docs).not.toContain("atlas-contract-dispute");
    expect(r.text).not.toContain(CANARY);
  });

  it("gives the denied principal nothing about Atlas", async () => {
    const bob = await as("bob");
    const r = await bob.req("POST", "/api/knowledge/search", { query: "Why was Project Atlas delayed?", limit: 10 });
    expect(r.json.evidence).toEqual([]);
    const notFound = await bob.req("GET", "/api/knowledge/documents/does-not-exist");
    const forbidden = await bob.req("GET", "/api/knowledge/documents/atlas-status-2026-04");
    expect(forbidden.status).toBe(404);
    // Indistinguishable from a missing document (no existence or title leak).
    expect({ ...forbidden.json, requestId: "" }).toEqual({ ...notFound.json, requestId: "" });
    expect(forbidden.text).not.toContain("Atlas");
  });

  it("protects the restricted memo document view", async () => {
    const alice = await as("alice");
    expect((await alice.req("GET", "/api/knowledge/documents/atlas-contract-dispute")).status).toBe(404);
    const carol = await as("carol");
    const ok = await carol.req("GET", "/api/knowledge/documents/atlas-contract-dispute");
    expect(ok.status).toBe(200);
    expect(ok.text).toContain(CANARY);
  });
});

describe("Project Assistant conversations", () => {
  it("answers the Atlas delay question with resolvable citations and keeps restricted text from the model", async () => {
    const alice = await as("alice");
    model.calls.length = 0;
    const { answer } = await ask(alice, "Why was Project Atlas delayed?");
    expect(answer.status).toBe("answered");
    expect(answer.content).toMatch(/Northwind/);
    expect(answer.content).toMatch(/customer/i);
    const citedDocs = answer.citations.map((c: { documentId: string }) => c.documentId);
    expect(citedDocs).toEqual(expect.arrayContaining(["atlas-status-2026-04", "atlas-steering-2026-05-12"]));
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(JSON.stringify(model.calls)).not.toContain(CANARY);
    expect(JSON.stringify(model.calls)).not.toContain("settlement");

    for (const c of answer.citations) {
      const r = await alice.req("GET", `/api/knowledge/evidence/${c.evidenceId}`);
      expect(r.status).toBe(200);
      expect(r.json.documentPath).toContain(c.documentId);
      expect((await alice.req("GET", `/api/knowledge/documents/${c.documentId}`)).status).toBe(200);
    }
    // Citations are bound to the principal they were issued to.
    const carol = await as("carol");
    const bob = await as("bob");
    expect((await carol.req("GET", `/api/knowledge/evidence/${answer.citations[0].evidenceId}`)).status).toBe(404);
    expect((await bob.req("GET", `/api/knowledge/evidence/${answer.citations[0].evidenceId}`)).status).toBe(404);
  });

  it("responds honestly when evidence is insufficient", async () => {
    const alice = await as("alice");
    const { answer } = await ask(alice, "What was the Atlas marketing budget for 2025?");
    expect(answer.status).toBe("insufficient_evidence");
    expect(answer.citations).toEqual([]);
    expect(answer.content).toMatch(/could not find enough authorized evidence/);
  });

  it("leaks no Atlas text, title or citation to the denied principal", async () => {
    const bob = await as("bob");
    const { answer } = await ask(bob, "Why was Project Atlas delayed?");
    expect(answer.status).toBe("insufficient_evidence");
    expect(answer.citations).toEqual([]);
    for (const s of ["Northwind", "Status Report", "Steering", CANARY]) expect(JSON.stringify(answer)).not.toContain(s);
  });

  it("enforces conversation ownership", async () => {
    const alice = await as("alice");
    const bob = await as("bob");
    const { conversationId } = await ask(alice, "Why was Project Atlas delayed?");
    expect((await alice.req("GET", `/api/conversations/${conversationId}`)).status).toBe(200);
    expect((await bob.req("GET", `/api/conversations/${conversationId}`)).status).toBe(404);
    expect((await bob.req("POST", `/api/conversations/${conversationId}/messages`, { content: "hi" })).status).toBe(404);
    const list = await bob.req("GET", "/api/conversations");
    expect(list.json.map((c: { id: string }) => c.id)).not.toContain(conversationId);
    expect((await bob.req("GET", "/api/conversations/not-a-uuid")).status).toBe(404);
  });

  it("withholds stored answers and citations after access is revoked", async () => {
    const repos = createRepositories(db);
    const carol = await as("carol");
    const { conversationId, answer } = await ask(carol, "Why was Project Atlas delayed?");
    expect(answer.status).toBe("answered");
    await repos.principals.setGroups("cust_demo", "carol", ["all-staff"]);
    try {
      const after = await carol.req("GET", `/api/conversations/${conversationId}`);
      const stored = after.json.messages.find((m: { role: string }) => m.role === "assistant");
      expect(stored.status).toBe("withheld");
      expect(stored.citations).toEqual([]);
      expect(after.text).not.toContain("Northwind");
      expect((await carol.req("GET", `/api/knowledge/evidence/${answer.citations[0].evidenceId}`)).status).toBe(404);
    } finally {
      await repos.principals.setGroups("cust_demo", "carol", ["all-staff", "atlas-team", "finance-legal"]);
    }
  });

  it("hides tombstoned documents immediately", async () => {
    const repos = createRepositories(db);
    const alice = await as("alice");
    await repos.catalog.tombstone("cust_demo", "atlas-status-2026-04");
    try {
      const r = await alice.req("POST", "/api/knowledge/search", { query: "Why was Project Atlas delayed?", limit: 10 });
      expect(r.json.evidence.map((e: { documentId: string }) => e.documentId)).not.toContain("atlas-status-2026-04");
      expect((await alice.req("GET", "/api/knowledge/documents/atlas-status-2026-04")).status).toBe(404);
    } finally {
      await seedFixtures(db, FIXTURES_ROOT, "cust_demo"); // re-publishes the fixture
    }
  });

  it("audits without storing message content", async () => {
    const rows = await createRepositories(db).audit.list("cust_demo", 500);
    expect(rows.some((r) => r.action === "agent.run")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Why was Project Atlas delayed");
  });
});

describe("integrations: context router, MCP and approvals", () => {
  it("routes a current-status question to the live MCP tracker and cites both sources", async () => {
    const alice = await as("alice");
    const { answer } = await ask(alice, "What is the current status of the Atlas customer data migration?");
    expect(answer.status).toBe("answered");
    const live = answer.citations.filter((c: { kind?: string }) => c.kind === "live");
    expect(live.length).toBeGreaterThan(0);
    expect(live[0]).toMatchObject({ resourceId: "ATLAS-142", connectorId: "atlas-tracker" });
    expect(answer.toolCalls.map((t: { capabilityId: string }) => t.capabilityId)).toEqual(expect.arrayContaining(["knowledge.search", "tracker.tasks.list", "tracker.task.status"]));
    // Live citations resolve only for their owner.
    expect((await alice.req("GET", `/api/live-evidence/${live[0].evidenceId}`)).status).toBe(200);
    const carol = await as("carol");
    expect((await carol.req("GET", `/api/live-evidence/${live[0].evidenceId}`)).status).toBe(404);
  });

  it("does not offer tracker tools to principals outside atlas-team", async () => {
    const bob = await as("bob");
    const caps = (await bob.req("GET", "/api/capabilities")).json.map((c: { id: string }) => c.id);
    expect(caps).toEqual(["knowledge.search"]);
    const { answer } = await ask(bob, "What is the current status of ATLAS-142?");
    expect(JSON.stringify(answer)).not.toContain("ATLAS-142\",\"connectorId");
    expect(answer.toolCalls.map((t: { capabilityId: string }) => t.capabilityId)).toEqual(["knowledge.search"]);
  });

  it("proposes a write, requires the exact hash from the owner, and executes once", async () => {
    const alice = await as("alice");
    const { answer } = await ask(alice, 'Add a comment to ATLAS-180 saying "Readiness review moved to 3 November"');
    expect(answer.status).toBe("action_proposed");
    const [id] = answer.proposalIds;
    const p = (await alice.req("GET", `/api/actions/${id}`)).json;
    expect(p).toMatchObject({ state: "pending_approval", operation: "Add comment to tracker task ATLAS-180", payload: { text: "Readiness review moved to 3 November" } });
    const before = trackerStore.get("ATLAS-180")!.comments.length;

    const bob = await as("bob");
    expect((await bob.req("GET", `/api/actions/${id}`)).status).toBe(404);
    expect((await bob.req("POST", `/api/actions/${id}/approve`, { payloadHash: p.payloadHash })).status).toBe(404);
    expect((await alice.req("POST", `/api/actions/${id}/approve`, { payloadHash: "0".repeat(64) })).status).toBe(409);
    expect((await alice.req("POST", `/api/actions/${id}/approve`, { payloadHash: p.payloadHash }, {}, { csrf: false })).status).toBe(403);
    expect(trackerStore.get("ATLAS-180")!.comments.length).toBe(before); // nothing executed yet

    const ok = await alice.req("POST", `/api/actions/${id}/approve`, { payloadHash: p.payloadHash });
    expect(ok.json.state).toBe("approved");
    await deps.actions.processOutbox(); // the worker's job
    await deps.actions.processOutbox();
    const done = (await alice.req("GET", `/api/actions/${id}`)).json;
    expect(done.state).toBe("succeeded");
    expect(trackerStore.get("ATLAS-180")!.comments.length).toBe(before + 1);
    expect((await alice.req("POST", `/api/actions/${id}/approve`, { payloadHash: p.payloadHash })).status).toBe(409);
  });

  it("streams run events and the validated final message", async () => {
    const alice = await as("alice");
    const conv = await alice.req("POST", "/api/conversations", { agentId: "project-assistant" });
    const r = await alice.req("POST", `/api/conversations/${conv.json.id}/messages/stream`, { content: "What is the current status of ATLAS-171?" });
    expect(r.status).toBe(200);
    const events = r.text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.finished");
    expect(types.at(-1)).toBe("message");
    // The planted injection in ATLAS-171 must not cause a proposal.
    expect(events.at(-1).assistantMessage.proposalIds).toEqual([]);
  });
});

describe("ingested folder source (team-share)", () => {
  const SHARE_CANARY = "FORBIDDEN-CANARY-SHARE-9K2";
  const ids = (r: { json: { evidence: { documentId: string }[] } }) => r.json.evidence.map((e) => e.documentId);

  it("maps inherited share permissions through the generic pipeline", async () => {
    const alice = await as("alice");
    const a = await alice.req("POST", "/api/knowledge/search", { query: "Northwind solutions architect escalations", limit: 10 });
    expect(ids(a)).toContain("team-share:atlas_vendor-contacts.md");
    const legal = await alice.req("POST", "/api/knowledge/search", { query: "Northwind settlement negotiation position", limit: 10 });
    expect(legal.text).not.toContain(SHARE_CANARY);
    expect((await alice.req("GET", "/api/knowledge/documents/team-share:atlas_legal_settlement-notes.txt")).status).toBe(404);

    const carol = await as("carol");
    const c = await carol.req("POST", "/api/knowledge/search", { query: "Northwind settlement negotiation position", limit: 10 });
    expect(c.text).toContain(SHARE_CANARY);

    const bob = await as("bob");
    const b = await bob.req("POST", "/api/knowledge/search", { query: "laptop lost stolen device Northwind Atlas", limit: 10 });
    expect([...new Set(ids(b))]).toEqual(["team-share:handbook_it-equipment-policy.md"]);
  });

  it("keeps unmapped-permission documents unsearchable and quarantines unsupported files", async () => {
    for (const p of ["alice", "bob", "carol"]) {
      const s = await as(p);
      const r = await s.req("POST", "/api/knowledge/search", { query: "contractor onboarding temporary account", limit: 10 });
      expect(ids(r)).not.toContain("team-share:contractors_onboarding.md");
    }
    const q = await createRepositories(db).sources.listQuarantine("cust_demo", "team-share");
    expect(q.map((x) => [x.externalId, x.reason])).toEqual([["atlas/architecture-diagram.pdf", "needs_ocr"]]);
    const state = await createRepositories(db).sources.getState("cust_demo", "team-share");
    expect(state?.lastRun).toMatchObject({ full: true, unmappedAcl: 1 });
  });

  it("serves the protected document view from the content store", async () => {
    const alice = await as("alice");
    const r = await alice.req("GET", "/api/knowledge/documents/team-share:atlas_cutover-runbook.html");
    expect(r.status).toBe(200);
    expect(r.json.chunks.map((c: { location?: string }) => c.location)).toEqual(expect.arrayContaining(["Before cutover", "Cutover night"]));
  });
});

describe("runs are owned by the server, not the HTTP request", () => {
  /** Makes the fake model slow (abortable), like a real CPU model. */
  const slowModel = (ms: number) => {
    const original = model.generate.bind(model);
    model.generate = async (req) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        req.signal?.addEventListener("abort", () => (clearTimeout(t), reject(req.signal!.reason)), { once: true });
      });
      return original(req);
    };
    return () => (model.generate = original);
  };
  const conversation = async (c: Client) => (await c.req("POST", "/api/conversations", { agentId: "project-assistant" })).json.id as string;
  const waitIdle = async (c: Client, id: string) => {
    for (let i = 0; i < 50; i++) {
      const d = await c.req("GET", `/api/conversations/${id}`);
      if (!d.json.runInProgress) return d.json;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("run did not finish");
  };

  it("a client that disconnects from the stream still gets its answer stored", async () => {
    const restore = slowModel(800);
    try {
      const alice = await as("alice");
      const id = await conversation(alice);
      const ac = new AbortController();
      const streaming = fetch(`${base}/api/conversations/${id}/messages/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: [...alice.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-csrf-token": alice.cookies.get("platform_csrf")! },
        body: JSON.stringify({ content: "Why was Project Atlas delayed?" }),
        signal: ac.signal,
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      ac.abort(); // the user closes the tab
      await streaming;
      expect((await alice.req("GET", `/api/conversations/${id}`)).json.runInProgress).toBe(true);
      const done = await waitIdle(alice, id);
      expect(done.messages.at(-1)).toMatchObject({ role: "assistant", status: "answered" });
    } finally {
      restore();
    }
  });

  it("allows one question at a time per conversation, and cancel stops the run", async () => {
    const restore = slowModel(5000);
    try {
      const alice = await as("alice");
      const bob = await as("bob");
      const id = await conversation(alice);
      const first = alice.req("POST", `/api/conversations/${id}/messages`, { content: "Why was Project Atlas delayed?" });
      await new Promise((r) => setTimeout(r, 200));
      expect((await alice.req("POST", `/api/conversations/${id}/messages`, { content: "And now?" })).status).toBe(409);
      expect((await bob.req("POST", `/api/conversations/${id}/cancel`)).status).toBe(404); // only the owner
      expect((await alice.req("POST", `/api/conversations/${id}/cancel`, undefined, {}, { csrf: false })).status).toBe(403);
      expect((await alice.req("POST", `/api/conversations/${id}/cancel`)).json).toEqual({ cancelled: true });
      const r = await first;
      expect(r.json.assistantMessage.status).not.toBe("answered");
      expect((await waitIdle(alice, id)).runInProgress).toBe(false);
      expect((await alice.req("POST", `/api/conversations/${id}/cancel`)).json).toEqual({ cancelled: false });
    } finally {
      restore();
    }
  });
});

describe("second agent and scheduled workflows (Stage 3c)", () => {
  it("lists both agents and starts a Meeting Preparation conversation", async () => {
    const alice = await as("alice");
    const agents = await alice.req("GET", "/api/agents");
    expect(agents.json.map((a: { id: string }) => a.id).sort()).toEqual(["meeting-prep", "project-assistant"]);
    expect((await alice.req("POST", "/api/conversations", { agentId: "meeting-prep" })).status).toBe(201);
  });

  it("creates, runs and controls a workflow only for its owner; its writes wait for approval", async () => {
    const alice = await as("alice");
    const bob = await as("bob");
    const body = { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 };
    expect((await alice.req("GET", "/api/workflow-kinds")).json.map((k: { kind: string }) => k.kind)).toContain("tracker-status-check");
    expect((await alice.req("POST", "/api/workflows", body, {}, { csrf: false })).status).toBe(403);
    expect((await bob.req("POST", "/api/workflows", body)).status).toBe(404); // bob lacks the tracker capabilities
    expect((await alice.req("POST", "/api/workflows", { ...body, config: { project: "x/../y" } })).status).toBe(400);
    expect((await alice.req("POST", "/api/workflows", { ...body, intervalMinutes: 1 })).status).toBe(400);

    const created = await alice.req("POST", "/api/workflows", body);
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect((await bob.req("GET", `/api/workflows/${id}/runs`)).status).toBe(404);
    expect((await bob.req("GET", "/api/workflows")).json).toEqual([]);

    await deps.workflows.tick(); // what the worker does every minute
    const runs = await alice.req("GET", `/api/workflows/${id}/runs`);
    expect(runs.json[0]).toMatchObject({ status: "succeeded", result: { project: "ATLAS", proposals: [{ taskKey: "ATLAS-180" }] } });
    const proposalId = runs.json[0].result.proposals[0].proposalId as string;
    const p = await alice.req("GET", `/api/actions/${proposalId}`);
    expect(p.json).toMatchObject({ state: "pending_approval", capabilityId: "tracker.task.comment" });
    expect((await bob.req("GET", `/api/actions/${proposalId}`)).status).toBe(404);

    expect((await alice.req("POST", `/api/workflows/${id}/pause`)).json.enabled).toBe(false);
    expect((await alice.req("POST", `/api/workflows/${id}/run-now`)).json.enabled).toBe(true);
    expect((await bob.req("POST", `/api/workflows/${id}/pause`)).status).toBe(404);
    const list = await alice.req("GET", "/api/workflows");
    expect(list.json[0]).toMatchObject({ id, title: "Tracker status check · ATLAS", lastRun: { status: "succeeded" } });
  });
});

describe("Bulgarian documents and questions", () => {
  it("answers a Bulgarian question in Bulgarian, citing the Bulgarian document", async () => {
    const alice = await as("alice");
    const { answer } = await ask(alice, "Защо се забави проектът Атлас?");
    expect(answer.status).toBe("answered");
    expect(answer.content).toMatch(/^Според цитираните източници:/);
    // Matches "проектът"/"Атлас". Verb forms (забави / забавено) are beyond the light stemmer; real models and semantic scoring cover them.
    expect(answer.content).toContain("Проектът Атлас е в жълт статус");
    expect(answer.citations.map((c: { documentId?: string }) => c.documentId)).toContain("atlas-status-bg");
  });

  it("keeps permissions in Bulgarian: the denied principal gets the Bulgarian refusal and nothing about Atlas", async () => {
    const bob = await as("bob");
    const { answer } = await ask(bob, "Защо се забави проектът Атлас?");
    expect(answer.status).toBe("insufficient_evidence");
    expect(answer.content).toMatch(/^Не намерих достатъчно информация/);
    expect(JSON.stringify(answer)).not.toMatch(/Атлас – седмичен|Northwind|atlas-status/);
    const leave = await ask(bob, "Колко дни платен годишен отпуск имат служителите?");
    expect(leave.answer.status).toBe("answered");
    expect(leave.answer.content).toContain("20 работни дни");
    expect(leave.answer.citations.map((c: { documentId?: string }) => c.documentId)).toContain("handbook-otpuski-bg");
  });

  it("finds Bulgarian documents through search", async () => {
    const alice = await as("alice");
    const r = await alice.req("POST", "/api/knowledge/search", { query: "блокер сертифициране Northwind", limit: 5 });
    expect(r.json.evidence[0]).toMatchObject({ documentId: "atlas-status-bg" });
  });
});

describe("admin console (ADR 0012)", () => {
  const ROUTES = ["overview", "sources", "sources/team-share/quarantine", "integrations", "agents", "actions", "workflows", "audit"];

  it("is invisible to non-admins (404 everywhere), and the denial is audited", async () => {
    const alice = await as("alice");
    expect((await alice.req("GET", "/api/auth/me")).json.roles).not.toContain("admin");
    for (const r of ROUTES) expect((await alice.req("GET", `/api/admin/${r}`)).status, r).toBe(404);
    expect((await alice.req("POST", "/api/admin/sources/team-share/sync")).status).toBe(404);
    const dana = await as("dana");
    const denied = await dana.req("GET", "/api/admin/audit?action=admin.access&principal=alice");
    expect(denied.json.length).toBeGreaterThan(0);
    expect(denied.json[0]).toMatchObject({ outcome: "denied", resourceType: "route" });
  });

  it("gives the admin operational views but no document access", async () => {
    const dana = await as("dana");
    expect((await dana.req("GET", "/api/auth/me")).json.roles).toContain("admin");
    const o = (await dana.req("GET", "/api/admin/overview")).json;
    expect(o.health.knowledge.ok).toBe(true);
    expect(o.sources.configured).toBeGreaterThanOrEqual(3);
    const sources = (await dana.req("GET", "/api/admin/sources")).json;
    expect(sources.find((s: { id: string }) => s.id === "team-share")).toMatchObject({ quarantined: 1, unsearchable: 1 });
    const q = (await dana.req("GET", "/api/admin/sources/team-share/quarantine")).json;
    expect(q[0]).toMatchObject({ externalId: "atlas/architecture-diagram.pdf", reason: "needs_ocr" });
    expect((await dana.req("GET", "/api/admin/sources/no-such-source/quarantine")).status).toBe(404);
    expect((await dana.req("GET", "/api/admin/agents")).json.map((a: { id: string }) => a.id).sort()).toEqual(["meeting-prep", "project-assistant"]);
    const integrations = (await dana.req("GET", "/api/admin/integrations")).json;
    expect(integrations[0]).toMatchObject({ id: "atlas-tracker" });
    expect(integrations[0].tools.every((t: { enabled: boolean }) => t.enabled)).toBe(true);

    // Administration is not document access: Dana searches with her own groups (all-staff).
    const search = await dana.req("POST", "/api/knowledge/search", { query: "Why was Project Atlas delayed?", limit: 5 });
    expect(JSON.stringify(search.json)).not.toMatch(/Atlas Status Report|Northwind|FORBIDDEN-CANARY/);
  });

  it("never returns document text, excerpts or proposal payload values", async () => {
    const alice = await as("alice");
    const marker = "ADMIN-MUST-NOT-SEE-7731";
    await ask(alice, `Add a comment to ATLAS-180 saying "${marker}"`);
    const dana = await as("dana");
    const actions = (await dana.req("GET", "/api/admin/actions")).json;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]).toHaveProperty("payloadFields");
    let everything = "";
    for (const r of ROUTES) everything += (await dana.req("GET", `/api/admin/${r}`)).text;
    expect(everything).not.toContain(marker); // comment text written by alice
    expect(everything).not.toContain("FORBIDDEN-CANARY-7Q4X"); // restricted memo text
    expect(everything).not.toContain("certification slipped by six weeks"); // a sentence from the Atlas status report body
    expect(actions.some((a: { payloadFields: string[] }) => a.payloadFields.includes("text"))).toBe(true); // the proposal exists, only its value is hidden
  });

  it("records a sync request (CSRF-protected) that the worker picks up", async () => {
    const dana = await as("dana");
    expect((await dana.req("POST", "/api/admin/sources/team-share/sync", undefined, {}, { csrf: false })).status).toBe(403);
    expect((await dana.req("POST", "/api/admin/sources/nope/sync")).status).toBe(404);
    const r = await dana.req("POST", "/api/admin/sources/team-share/sync");
    expect(r.status).toBe(202);
    const s = (await dana.req("GET", "/api/admin/sources")).json.find((x: { id: string }) => x.id === "team-share");
    expect(s).toMatchObject({ syncRequested: true, syncRequestedBy: "dana" });
    expect(await deps.admin.pendingSyncRequests("cust_demo")).toContain("team-share");
    await deps.admin.clearSyncRequest("cust_demo", "team-share", new Date());
    expect(await deps.admin.pendingSyncRequests("cust_demo")).not.toContain("team-share");
    const audit = (await dana.req("GET", "/api/admin/audit?action=admin.source")).json;
    expect(audit[0]).toMatchObject({ action: "admin.source.sync_requested", principalId: "dana", resourceId: "team-share" });
  });
});

describe("development authentication switch", () => {
  it("is unavailable when DEV_AUTH_ENABLED is false", async () => {
    const off = await boot({ DEV_AUTH_ENABLED: "false" });
    try {
      const c = new Client(off.base);
      await c.req("GET", "/api/auth/csrf");
      expect((await c.req("POST", "/api/auth/dev-login", { principalId: "alice" })).status).toBe(404);
      expect((await c.req("GET", "/api/auth/dev-principals")).status).toBe(404);
    } finally {
      await off.app.close();
    }
  });
});
