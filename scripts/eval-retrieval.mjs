#!/usr/bin/env node
// Knowledge selection gate (stage 3b): retrieval evaluation over the HTTP API.
//
//   EVAL_BASE_URL=http://localhost:4000 EVAL_LABEL=lexical node scripts/eval-retrieval.mjs
//   EVAL_BASE_URL=https://localhost:8443 SMOKE_INSECURE_TLS=1 EVAL_LABEL=lightrag node scripts/eval-retrieval.mjs
//   EVAL_QUESTIONS=fixtures/eval/questions-hard.json EVAL_LABEL=lexical-hard node scripts/eval-retrieval.mjs
//
// Requires the eval corpus to be ingested (KNOWLEDGE_INCLUDE_EVAL_CORPUS=true) and dev sign-in.
// Writes docs/eval/<date>-<label>.{json,md}. Gates are the handoff's proposed pilot gates.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.env.SMOKE_INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = (process.env.EVAL_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const LABEL = process.env.EVAL_LABEL ?? "run";
const K = 5;
const MIN_EVIDENCE_SCORE = 0.6; // Project Assistant's minEvidenceScore (abstention proxy)
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const QUESTIONS = process.env.EVAL_QUESTIONS ?? "fixtures/eval/questions.json";
// A question file may hold only questions; corpus facts (sourceId, readablePrefixes) come from the generated set.
const spec = {
  ...JSON.parse(await readFile(`${ROOT}fixtures/eval/questions.json`, "utf8")),
  ...JSON.parse(await readFile(`${ROOT}${QUESTIONS}`, "utf8")),
};
const docId = (rel) => `${spec.sourceId}:${rel}`.replace(/[^A-Za-z0-9._:#-]/g, "_");
const relOf = new Map();

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
}
const sessions = {};
async function as(p) {
  if (sessions[p]) return sessions[p];
  const s = new Session();
  await s.req("GET", "/api/auth/csrf");
  const r = await s.req("POST", "/api/auth/dev-login", { principalId: p });
  if (r.status !== 200) throw new Error(`login ${p}: ${r.status}`);
  return (sessions[p] = s);
}

// Every corpus file the principal may read, for leak detection independent of the API.
const corpusIds = new Set();
for (const q of spec.questions) for (const f of [...q.supporting, ...(q.superseded ?? [])]) relOf.set(docId(f), f);
const readableBy = (principal, documentId) => {
  if (!documentId.startsWith(`${spec.sourceId}:`)) return true; // other sources: policy-checked elsewhere
  const flat = documentId.slice(spec.sourceId.length + 1);
  return spec.readablePrefixes[principal].some((p) => flat.startsWith(p.replace(/\//g, "_")));
};

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 100);
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

const rows = [];
const retried = [];
for (const q of spec.questions) {
  const s = await as(q.principal);
  const t0 = performance.now();
  let r = await s.req("POST", "/api/knowledge/search", { query: q.question, limit: 10 });
  if (r.status === 503) {
    // A transient backend failure (e.g. the local model runner restarting) is not a retrieval miss: retry once, and report it.
    retried.push(q.id);
    await new Promise((res) => setTimeout(res, 15_000));
    r = await s.req("POST", "/api/knowledge/search", { query: q.question, limit: 10 });
  }
  const ms = Math.round(performance.now() - t0);
  if (r.status !== 200) throw new Error(`${q.id}: search failed ${r.status} ${r.text.slice(0, 200)}`);
  const ev = r.json.evidence;
  const top = ev.slice(0, K).map((e) => e.documentId);
  const maxScore = ev.reduce((m, e) => Math.max(m, e.score), 0);
  const supportingIds = q.supporting.map(docId);
  // Multi-document questions (requireAll) need every supporting document in the top K.
  const hit = supportingIds.length ? (q.requireAll ? supportingIds.every((id) => top.includes(id)) : supportingIds.some((id) => top.includes(id))) : null;
  const leaks = ev.filter((e) => !readableBy(q.principal, e.documentId)).map((e) => e.documentId);
  const forbiddenPrefix = (q.mustNotRetrievePrefixes ?? []).flatMap((p) => ev.filter((e) => e.documentId.startsWith(docId(p))).map((e) => e.documentId));
  const canaryLeak = q.principal !== "carol" && r.text.includes("CANARY-FL-");
  let versionOk = null;
  if (q.superseded?.length) {
    const rank = (id) => {
      const i = ev.findIndex((e) => e.documentId === id);
      return i < 0 ? Infinity : i;
    };
    versionOk = rank(supportingIds[0]) < rank(docId(q.superseded[0]));
  }
  rows.push({
    id: q.id,
    principal: q.principal,
    type: q.type,
    category: q.category,
    question: q.question,
    ms,
    hit,
    versionOk,
    wouldAnswer: maxScore >= MIN_EVIDENCE_SCORE,
    maxScore: Math.round(maxScore * 100) / 100,
    leaks: [...new Set([...leaks, ...forbiddenPrefix])],
    canaryLeak,
    top,
  });
  process.stdout.write(`${q.id} ${hit === false ? "MISS" : hit ? "hit " : "-   "} ${ms}ms ${q.question}\n`);
}

const answerable = rows.filter((r) => r.type === "answerable");
const unanswerable = rows.filter((r) => r.type === "unanswerable");
const leakRows = rows.filter((r) => r.leaks.length || r.canaryLeak);
const versionRows = rows.filter((r) => r.versionOk !== null);
const lat = rows.map((r) => r.ms);
const byCategory = {};
for (const r of answerable) {
  byCategory[r.category] ??= { hits: 0, total: 0 };
  byCategory[r.category].total++;
  if (r.hit) byCategory[r.category].hits++;
}
const summary = {
  label: LABEL,
  date: new Date().toISOString(),
  base: BASE,
  corpusFiles: spec.corpusFiles,
  questions: rows.length,
  recallAt5: pct(answerable.filter((r) => r.hit).length, answerable.length),
  abstentionProxy: pct(unanswerable.filter((r) => !r.wouldAnswer).length, unanswerable.length),
  falseAbstentionProxy: pct(answerable.filter((r) => !r.wouldAnswer).length, answerable.length),
  latestVersionRankedFirst: pct(versionRows.filter((r) => r.versionOk).length, versionRows.length),
  unauthorizedResults: leakRows.length,
  latencyMs: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), max: Math.max(...lat) },
  byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, `${v.hits}/${v.total}`])),
  retriedAfter503: retried,
};
const gates = [
  ["Top-5 recall of labeled evidence (answerable)", "≥ 85%", `${summary.recallAt5}%`, summary.recallAt5 >= 85],
  ["Unanswerable questions would abstain (proxy)", "100%", `${summary.abstentionProxy}%`, summary.abstentionProxy === 100],
  ["Unauthorized passages returned", "0", String(summary.unauthorizedResults), summary.unauthorizedResults === 0],
];

const date = summary.date.slice(0, 10);
await mkdir(`${ROOT}docs/eval`, { recursive: true });
await writeFile(`${ROOT}docs/eval/${date}-${LABEL}.json`, JSON.stringify({ summary, rows }, null, 2) + "\n");
const md = `# Retrieval evaluation · ${LABEL} · ${date}

Generated by \`scripts/eval-retrieval.mjs\` against \`${BASE}\`, using the
synthetic corpus (${spec.corpusFiles} files) and ${rows.length} labeled
questions (\`${QUESTIONS}\`).

## Gates (handoff §3, proposed pilot gates)

| Gate | Target | Measured | Result |
|---|---|---|---|
${gates.map(([g, t, m, ok]) => `| ${g} | ${t} | ${m} | ${ok ? "pass" : "**fail**"} |`).join("\n")}

## Further measurements

| Measure | Value |
|---|---|
| Current version ranked above superseded (conflicting versions) | ${summary.latestVersionRankedFirst}% |
| Answerable questions below the evidence threshold (would abstain wrongly) | ${summary.falseAbstentionProxy}% |
| Search latency p50 / p95 / max | ${summary.latencyMs.p50} / ${summary.latencyMs.p95} / ${summary.latencyMs.max} ms |
| Recall by category | ${Object.entries(summary.byCategory).map(([k, v]) => `${k} ${v}`).join(" · ")} |
| Retried once after a backend 503 | ${retried.length ? retried.join(", ") : "none"} |

Not measured here:
- **Citation support (gate ≥ 95%)** needs model answers. Run with a real model
  through \`scripts/integration-live-check.mjs\` or the conversation API.
- **Abstention** is measured as a proxy: whether the best evidence score is
  below the agent's \`minEvidenceScore\` (${MIN_EVIDENCE_SCORE}).

## Misses and problems

${
  rows
    .filter((r) => r.hit === false || r.leaks.length || r.canaryLeak || (r.type === "unanswerable" && r.wouldAnswer) || r.versionOk === false)
    .map((r) => `- **${r.id}** (${r.principal}, ${r.category}) ${r.question}: ${[
      r.hit === false ? "supporting document not in top 5" : "",
      r.leaks.length ? `LEAK ${r.leaks.join(", ")}` : "",
      r.canaryLeak ? "CANARY LEAK" : "",
      r.type === "unanswerable" && r.wouldAnswer ? `would answer (max score ${r.maxScore})` : "",
      r.versionOk === false ? "superseded version ranked first" : "",
    ]
      .filter(Boolean)
      .join("; ")}. Top: ${r.top.slice(0, 3).join(", ")}`)
    .join("\n") || "None."
}
`;
await writeFile(`${ROOT}docs/eval/${date}-${LABEL}.md`, md);
console.log(`\n${JSON.stringify(summary, null, 2)}\nreport: docs/eval/${date}-${LABEL}.md`);
process.exit(gates.every((g) => g[3]) ? 0 : 1);
