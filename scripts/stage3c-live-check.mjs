#!/usr/bin/env node
// Live Stage-3c check against the running stack: the Meeting Preparation
// Assistant (calendar MCP + knowledge + tracker) and the durable scheduled
// status-check workflow with approvals.
//
//   SMOKE_INSECURE_TLS=1 node scripts/stage3c-live-check.mjs              # workflow + permissions (~3-5 min)
//   SMOKE_INSECURE_TLS=1 WITH_MODEL=1 node scripts/stage3c-live-check.mjs # + 2 real-model briefings (~5-15 min more)
//   SKIP_WORKFLOW=1 WITH_MODEL=1 ...                                       # only the briefings
//
// Requires the compose overlays: base + dev + lightrag + integrations (with the
// calendar server and TRACKER_TEST_HOOKS=1), seeded and synced.
import { execFileSync } from "node:child_process";

if (process.env.SMOKE_INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = (process.env.SMOKE_BASE_URL ?? "https://localhost:8443").replace(/\/$/, "");
const TRACKER = process.env.TRACKER_CONTAINER ?? "ai-platform-mcp-atlas-tracker-1";
const TRACKER_TOKEN = process.env.MCP_TOKEN_ATLAS_TRACKER ?? "dev-tracker-token-0123456789abcd";
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  cookies = new Map();
  async req(method, path, body) {
    const headers = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && this.cookies.has("platform_csrf")) headers["x-csrf-token"] = this.cookies.get("platform_csrf");
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  }
  async login(p) {
    await this.req("GET", "/api/auth/csrf");
    const r = await this.req("POST", "/api/auth/dev-login", { principalId: p });
    if (r.status !== 200) throw new Error(`login ${p}: ${r.status}`);
    return this;
  }
}

/** Synthetic test hook inside the tracker container (not reachable from the host network). */
function setTaskStatus(key, status) {
  const js = `fetch("http://127.0.0.1:8080/test/tasks/${key}/status",{method:"POST",headers:{authorization:"Bearer ${TRACKER_TOKEN}","content-type":"application/json"},body:JSON.stringify({status:"${status}"})}).then(r=>r.text()).then(t=>console.log(t))`;
  return JSON.parse(execFileSync("docker", ["exec", TRACKER, "node", "-e", js], { encoding: "utf8" }));
}

/** Waits for the worker's minute tick to produce a newer finished run. */
async function nextRun(s, id, after, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const runs = (await s.req("GET", `/api/workflows/${id}/runs`)).json ?? [];
    const done = runs.find((r) => (r.status === "succeeded" || r.status === "failed") && r.scheduledFor > after);
    if (done) return { run: done, seconds: Math.round((Date.now() - t0) / 1000) };
    await sleep(5000);
  }
  return { run: undefined, seconds: Math.round(timeoutMs / 1000) };
}

const alice = await new Session().login("alice");
const bob = await new Session().login("bob");

// --- permissions ------------------------------------------------------------------
const ready = (await (await fetch(`${BASE}/api/ready`)).json()).checks ?? {};
check("calendar connector healthy and pinned", String(ready["connector:calendar"]?.detail ?? "").startsWith("healthy"), ready["connector:calendar"]?.detail);
const agents = (await alice.req("GET", "/api/agents")).json.map((a) => a.id);
check("both agents registered", agents.includes("meeting-prep") && agents.includes("project-assistant"), agents.join(","));
const capsA = (await alice.req("GET", "/api/capabilities")).json.map((c) => c.id);
const capsB = (await bob.req("GET", "/api/capabilities")).json.map((c) => c.id);
check("alice: calendar and tracker capabilities", capsA.includes("calendar.events.list") && capsA.includes("tracker.task.comment"), capsA.join(","));
check("bob: calendar only, no tracker", capsB.includes("calendar.events.list") && !capsB.some((c) => c.startsWith("tracker.")), capsB.join(","));
const body = { kind: "tracker-status-check", config: { project: "ATLAS" }, intervalMinutes: 60 };
check("bob cannot create a tracker workflow", (await bob.req("POST", "/api/workflows", body)).status === 404);

// --- durable workflow --------------------------------------------------------------
if (process.env.SKIP_WORKFLOW !== "1") {
setTaskStatus("ATLAS-171", "In progress");
const w = (await alice.req("POST", "/api/workflows", body)).json;
check("alice creates a status-check workflow", !!w?.id, w?.title);
let r = await nextRun(alice, w.id, "");
const first = r.run?.result?.proposals ?? [];
check("worker runs it within its tick", r.run?.status === "succeeded", `${r.seconds}s, ${r.run?.status}`);
check("first run proposes for the at-risk task", first.some((p) => p.taskKey === "ATLAS-180"), JSON.stringify(first));
const p180 = first.find((p) => p.taskKey === "ATLAS-180");
const pv = p180 ? (await alice.req("GET", `/api/actions/${p180.proposalId}`)).json : undefined;
check("its write waits for approval", pv?.state === "pending_approval", pv?.operation);
check("bob cannot see alice's workflow proposal", p180 ? (await bob.req("GET", `/api/actions/${p180.proposalId}`)).status === 404 : false);

const blocked = setTaskStatus("ATLAS-171", "Blocked");
check("test hook blocks ATLAS-171", blocked.status === "Blocked");
await alice.req("POST", `/api/workflows/${w.id}/run-now`);
r = await nextRun(alice, w.id, r.run.scheduledFor);
const second = r.run?.result?.proposals ?? [];
check("change detected and proposed once", second.length === 1 && second[0].taskKey === "ATLAS-171", `${r.seconds}s ${JSON.stringify(r.run?.result?.changes ?? [])}`);

await alice.req("POST", `/api/workflows/${w.id}/run-now`);
r = await nextRun(alice, w.id, r.run.scheduledFor);
check("unchanged state proposes nothing", r.run?.status === "succeeded" && (r.run?.result?.proposals ?? []).length === 0, `${r.seconds}s`);

if (p180) {
  await alice.req("POST", `/api/actions/${p180.proposalId}/approve`, { payloadHash: pv.payloadHash });
  let state = "";
  for (let i = 0; i < 40 && !["succeeded", "failed", "unknown"].includes(state); i++) {
    await sleep(1500);
    state = (await alice.req("GET", `/api/actions/${p180.proposalId}`)).json?.state;
  }
  check("approved workflow proposal executes", state === "succeeded", state);
}
await alice.req("POST", `/api/workflows/${w.id}/pause`);
setTaskStatus("ATLAS-171", "In progress");
}

// --- A real-model answer survives a client disconnect ---------------------------------
if (process.env.WITH_MODEL === "1") {
  const c = (await alice.req("POST", "/api/conversations", { agentId: "project-assistant" })).json;
  const ac = new AbortController();
  const headers = { "content-type": "application/json", cookie: [...alice.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-csrf-token": alice.cookies.get("platform_csrf") };
  const streaming = fetch(`${BASE}/api/conversations/${c.id}/messages/stream`, { method: "POST", headers, body: JSON.stringify({ content: "Why was Project Atlas delayed?" }), signal: ac.signal }).catch(() => undefined);
  await sleep(3000);
  ac.abort(); // the user closes the tab
  await streaming;
  check("run continues after the client disconnects", (await alice.req("GET", `/api/conversations/${c.id}`)).json?.runInProgress === true);
  const t0 = Date.now();
  let d;
  while (Date.now() - t0 < 12 * 60_000) {
    d = (await alice.req("GET", `/api/conversations/${c.id}`)).json;
    if (!d?.runInProgress) break;
    await sleep(10_000);
  }
  const last = d?.messages?.at(-1);
  check("its answer is stored for when the user returns", last?.role === "assistant" && last?.status === "answered", `${Math.round((Date.now() - t0) / 1000)}s, ${last?.status}`);
}

// --- Meeting Preparation Assistant (real model) -------------------------------------
if (process.env.WITH_MODEL === "1") {
  for (const [s, who, event, mustNot] of [
    [alice, "alice", "Atlas steering committee", []],
    [bob, "bob", "Office relocation Q&A", ["Northwind", "Atlas steering"]],
  ]) {
    const c = await s.req("POST", "/api/conversations", { agentId: "meeting-prep" });
    const t0 = Date.now();
    // Streaming endpoint (like the UI): headers arrive at once, so a multi-minute CPU answer doesn't hit fetch's header timeout.
    const stream = await s.req("POST", `/api/conversations/${c.json.id}/messages/stream`, { content: "Prepare me for my next meeting." });
    const m = stream.text
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)))
      .find((e) => e.type === "message")?.assistantMessage;
    const secs = Math.round((Date.now() - t0) / 1000);
    const live = (m?.citations ?? []).filter((x) => x.kind === "live").map((x) => x.resourceId);
    check(`${who}: briefing cites own calendar event`, live.some((id) => id.startsWith(`evt-${who}`)) && !live.some((id) => id.startsWith("evt-") && !id.startsWith(`evt-${who}`)), `${secs}s, live=${live.join(",")}`);
    check(`${who}: briefing names the meeting`, String(m?.content ?? "").includes(event.split(" ")[0]), event);
    for (const x of mustNot) check(`${who}: no "${x}"`, !JSON.stringify(m ?? {}).includes(x));
    console.log(`\n--- ${who} ---\n${String(m?.content ?? "(none)").replace(/\[\[((?:ev|lv)_[^\]]+)\]\]/g, (_x, id) => (id.startsWith("lv_") ? "[live]" : "[doc]"))}\n`);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll Stage 3c live checks passed");
process.exit(failures ? 1 : 0);
