#!/usr/bin/env node
// Live permission-change and deletion check against the REAL LightRAG stack.
// Requires the Compose stack with the LightRAG overlay running, seeded and synced.
//
//   SMOKE_INSECURE_TLS=1 node scripts/lightrag-live-check.mjs
//
// Steps (each verified over the platform's HTTP API):
//   1. carol (finance-legal) retrieves the restricted memo from its own partition
//   2. ACL change: atlas-status-2026-04 moves atlas-team -> finance-legal
//      a) BEFORE re-sync: nobody gets it from search (stale placement is ignored)
//      b) AFTER  re-sync: carol gets it, alice does not; old partition copy deleted
//   3. Tombstone: office-relocation-faq disappears immediately, then is physically
//      deleted from its partition by the sync (deletion verified)
//   4. Restore fixtures (re-seed + re-sync) and confirm alice's answer again
import { execFileSync } from "node:child_process";

if (process.env.SMOKE_INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = (process.env.SMOKE_BASE_URL ?? "https://localhost:8443").replace(/\/$/, "");
const COMPOSE = (process.env.COMPOSE_CMD ?? "docker compose").split(" ");
const FILES = ["-f", "infra/compose/compose.yaml", "-f", "infra/compose/compose.dev.yaml", "-f", "infra/compose/lightrag/compose.lightrag.yaml"];
const PG = process.env.PG_CONTAINER ?? "ai-platform-postgres-1";
let failures = 0;

const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const compose = (...args) => sh(COMPOSE[0], [...COMPOSE.slice(1), ...FILES, ...args]);
const sql = (q) => sh("docker", ["exec", PG, "psql", "-U", "platform", "-d", "platform", "-tAc", q]).trim();
const sync = () => {
  const t0 = Date.now();
  let out;
  try {
    out = compose("--profile", "lightrag-sync", "run", "--rm", "lightrag-sync");
  } catch (err) {
    out = String(err.stdout ?? ""); // exit code 2 = failures reported in the JSON summary
  }
  const line = out.split("\n").find((l) => l.includes("lightrag sync complete")) ?? "{}";
  const r = JSON.parse(line);
  if (r.failed?.length) console.log(`      sync failures: ${JSON.stringify(r.failed)}`);
  console.log(`      sync: inserted=${JSON.stringify(r.inserted)} deleted=${JSON.stringify((r.deleted ?? []).map((d) => `${d.partition}:${d.fileSource}`))} verified=${r.deletionVerified} (${Math.round((Date.now() - t0) / 1000)}s)`);
  return r;
};
const seed = () => compose("--profile", "seed", "run", "--rm", "seed");

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
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  }
  async login(p) {
    await this.req("GET", "/api/auth/csrf");
    const r = await this.req("POST", "/api/auth/dev-login", { principalId: p });
    if (r.status !== 200) throw new Error(`login ${p}: ${r.status}`);
    return this;
  }
  async docs(query) {
    const r = await this.req("POST", "/api/knowledge/search", { query, limit: 10 });
    if (r.status !== 200) throw new Error(`search failed: ${r.status} ${r.text}`);
    return r.json.evidence.map((e) => e.documentId);
  }
  async ask(q) {
    const c = await this.req("POST", "/api/conversations", { agentId: "project-assistant" });
    return (await this.req("POST", `/api/conversations/${c.json.id}/messages`, { content: q })).json.assistantMessage;
  }
}

const cfg = await (await fetch(`${BASE}/api/config/public`)).json();
check("platform uses the LightRAG provider", cfg.knowledgeProvider === "lightrag", cfg.knowledgeProvider);
const ready = await (await fetch(`${BASE}/api/ready`)).json();
check("readiness incl. all LightRAG partitions", ready.status === "ready", ready.checks?.knowledge?.detail);

const alice = await new Session().login("alice");
const bob = await new Session().login("bob");
const carol = await new Session().login("carol");
const Q = "Why was Project Atlas delayed?";

const t0 = Date.now();
const a = await alice.ask(Q);
check("alice: grounded answer via LightRAG", a.status === "answered" && a.citations.length > 0, `${a.status}, ${a.citations.length} citations, ${Date.now() - t0}ms`);
check("alice: no restricted memo", !JSON.stringify(a).includes("FORBIDDEN-CANARY-7Q4X"));
const bobDocs = await bob.docs(Q);
check("bob: no Atlas documents (all-staff FAQ may appear as low-relevance evidence)", !bobDocs.some((d) => d.startsWith("atlas-")), bobDocs.join(","));
check("carol: memo retrieved from finance-legal partition", (await carol.docs("Atlas Northwind contract dispute settlement")).includes("atlas-contract-dispute"));

// --- 2. ACL change -----------------------------------------------------------
sql(`update source_documents set acl_groups='["finance-legal"]'::jsonb, acl_revision=acl_revision+1 where document_id='atlas-status-2026-04'`);
check("ACL change, before sync: alice no longer gets the status report", !(await alice.docs(Q)).includes("atlas-status-2026-04"));
check("ACL change, before sync: carol does not get it from the stale partition", !(await carol.docs(Q)).includes("atlas-status-2026-04"));
const r1 = sync();
check("sync moved the document and verified deletion from the old partition", r1.inserted?.includes("atlas-status-2026-04") && r1.deleted?.some((d) => d.partition === "p_atlas_team") && r1.deletionVerified === true);
check("ACL change, after sync: carol gets it from finance-legal", (await carol.docs(Q)).includes("atlas-status-2026-04"));
check("ACL change, after sync: alice still does not", !(await alice.docs(Q)).includes("atlas-status-2026-04"));

// --- 3. Tombstone --------------------------------------------------------------
const FAQ_Q = "When does the head office move to the riverside building?";
check("before tombstone: bob can find the office FAQ", (await bob.docs(FAQ_Q)).includes("office-relocation-faq"));
sql(`update source_documents set tombstoned_at=now() where document_id='office-relocation-faq'`);
check("tombstone: hidden immediately (before physical deletion)", !(await bob.docs(FAQ_Q)).includes("office-relocation-faq"));
const r2 = sync();
check("sync physically deleted the tombstoned document (verified)", r2.deleted?.some((d) => d.partition === "p_handbook_all_staff") && r2.deletionVerified === true);

// --- 4. Restore -------------------------------------------------------------------
sql(`update source_documents set acl_groups='["atlas-team"]'::jsonb where document_id='atlas-status-2026-04'`);
seed(); // un-tombstones fixtures that still exist on disk
const r3 = sync();
check("restore: sync re-indexed moved/deleted documents", r3.inserted?.length === 2 && !r3.failed?.length && r3.deletionVerified === true, JSON.stringify(r3.inserted));
check("restore: bob finds the office FAQ again", (await bob.docs(FAQ_Q)).includes("office-relocation-faq"));
check("restore: alice gets the status report again", (await alice.docs(Q)).includes("atlas-status-2026-04"));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll LightRAG live checks passed");
process.exit(failures ? 1 : 0);
