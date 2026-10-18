#!/usr/bin/env node
// End-to-end smoke test of the first milestone demonstration, over HTTP.
//   SMOKE_BASE_URL=https://localhost:8443 node scripts/smoke.mjs   (Compose, TLS proxy)
//   SMOKE_BASE_URL=http://localhost:3000  node scripts/smoke.mjs   (pnpm dev)
// For Caddy's internal development CA set SMOKE_INSECURE_TLS=1 (local only).
if (process.env.SMOKE_INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = (process.env.SMOKE_BASE_URL ?? "https://localhost:8443").replace(/\/$/, "");
const CANARY = "FORBIDDEN-CANARY-7Q4X";
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

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
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, text, json };
  }
  async login(principalId) {
    await this.req("GET", "/api/auth/csrf");
    const r = await this.req("POST", "/api/auth/dev-login", { principalId });
    if (r.status !== 200) throw new Error(`dev login as ${principalId} failed: ${r.status} ${r.text}`);
    return this;
  }
  async ask(question) {
    const c = await this.req("POST", "/api/conversations", { agentId: "project-assistant" });
    const m = await this.req("POST", `/api/conversations/${c.json.id}/messages`, { content: question });
    return m.json.assistantMessage;
  }
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/ready`);
      if (r.ok) return (await r.json());
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${BASE}/api/ready did not become ready`);
}

const ready = await waitReady();
check("readiness", ready.status === "ready", JSON.stringify(ready.checks));
const cfg = await (await fetch(`${BASE}/api/config/public`)).json();
console.log(`      knowledge=${cfg.knowledgeProvider} model=${cfg.modelProvider} env=${cfg.environment}`);
const web = await fetch(`${BASE}/`);
check("web UI served", web.ok, `status ${web.status}`);

const alice = await new Session().login("alice");
const a = await alice.ask("Why was Project Atlas delayed?");
check("alice: grounded answer", a.status === "answered", a.status);
check("alice: mentions fixture blockers", /Northwind/.test(a.content) && /customer/i.test(a.content));
check("alice: has citations", a.citations.length > 0, `${a.citations.length} citations`);
check("alice: no restricted content", !JSON.stringify(a).includes(CANARY));
let resolvable = 0;
for (const c of a.citations) {
  const e = await alice.req("GET", `/api/knowledge/evidence/${c.evidenceId}`);
  const d = await alice.req("GET", `/api/knowledge/documents/${encodeURIComponent(c.documentId)}`);
  if (e.status === 200 && d.status === 200) resolvable++;
}
check("alice: all citations resolve", resolvable === a.citations.length, `${resolvable}/${a.citations.length}`);
console.log("\n--- answer (alice) ---\n" + a.content.replace(/\[\[(ev_[^\]]+)\]\]/g, "[cite]") + "\n----------------------\n");

const u = await alice.ask("What was the Atlas marketing budget for 2025?");
check("alice: unsupported question -> insufficient evidence", u.status === "insufficient_evidence" && u.citations.length === 0, u.status);

const bob = await new Session().login("bob");
const b = await bob.ask("Why was Project Atlas delayed?");
const leak = ["Northwind", "Atlas Status", "Steering", CANARY].filter((s) => JSON.stringify(b).includes(s));
check("bob (denied): no answer, no citations", b.status === "insufficient_evidence" && b.citations.length === 0, b.status);
check("bob (denied): no restricted text or titles", leak.length === 0, leak.join(","));
const bd = await bob.req("GET", "/api/knowledge/documents/atlas-status-2026-04");
check("bob (denied): document view hidden", bd.status === 404);
if (a.citations[0]) {
  const be = await bob.req("GET", `/api/knowledge/evidence/${a.citations[0].evidenceId}`);
  check("bob (denied): alice's citation not resolvable", be.status === 404);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
