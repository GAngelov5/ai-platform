#!/usr/bin/env node
// Answer-level gate (stage 3b): real model answers through the HTTP API.
//
//   EVAL_BASE_URL=http://localhost:4100 EVAL_LABEL=gemini node --env-file=.env scripts/eval-answers.mjs
//
// For every question it asks the assistant (a fresh conversation each time) and measures:
// - citation support: each cited sentence is judged against the excerpt it cites,
//   by a separate judge call to the same OpenAI-compatible model (MODEL_* from .env);
//   EVAL_JUDGE=0 skips this
// - right sources: an answerable question cites a document that holds the answer
// - abstention: unanswerable and near-miss questions are refused
// - permissions: no answer cites, or quotes, a document the asker may not read
// - language: Bulgarian questions get Bulgarian answers
//
// Requires the eval corpus to be ingested (KNOWLEDGE_INCLUDE_EVAL_CORPUS=true) and dev sign-in.
// Writes docs/eval/<date>-answers-<label>.{json,md}. Synthetic questions and documents only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.env.SMOKE_INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = (process.env.EVAL_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const LABEL = process.env.EVAL_LABEL ?? "run";
const AGENT = process.env.EVAL_AGENT ?? "knowledge-assistant";
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 1500);
const JUDGE = process.env.EVAL_JUDGE !== "0";
const ONLY = process.env.EVAL_ONLY ? new Set(process.env.EVAL_ONLY.split(",")) : undefined;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILES = (process.env.EVAL_QUESTIONS ?? "fixtures/eval/questions.json,fixtures/eval/questions-hard.json,fixtures/eval/questions-bg.json").split(",");

const base = JSON.parse(await readFile(`${ROOT}fixtures/eval/questions.json`, "utf8"));
const questions = [];
for (const f of FILES) for (const q of JSON.parse(await readFile(`${ROOT}${f}`, "utf8")).questions) if (!ONLY || ONLY.has(q.id)) questions.push(q);
const corpusDoc = (rel) => `${base.sourceId}:${rel}`.replace(/[^A-Za-z0-9._:#-]/g, "_");
const supportingIds = (q) => [...(q.supporting ?? []).map(corpusDoc), ...(q.supportingDocumentIds ?? [])];
/** Documents the asker must never see: eval-corpus files outside their prefixes, plus any listed explicitly. */
const forbidden = (q, documentId) => {
  if ((q.forbiddenDocumentIds ?? []).includes(documentId)) return true;
  if (!documentId.startsWith(`${base.sourceId}:`)) return false;
  const flat = documentId.slice(base.sourceId.length + 1);
  return !(base.readablePrefixes[q.principal] ?? []).some((p) => flat.startsWith(p.replace(/\//g, "_")));
};

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

// --- Judge: is a sentence supported by the excerpt it cites? ---------------------------------------
// A stronger model than the one being evaluated is the usual choice for a judge.
const judgeCfg = { url: process.env.MODEL_BASE_URL?.replace(/\/$/, ""), key: process.env.MODEL_API_KEY, model: process.env.EVAL_JUDGE_MODEL ?? "gemini-3.7-flash" };
async function judge(claim, sources) {
  const prompt = `You check citations in an assistant's answer. Answer with exactly one word.
SUPPORTED: every fact in the CLAIM is stated in the cited SOURCES. Paraphrase and translation are fine; so is using a source's title for context (a status report titled "Atlas ..." is about Atlas). A statement about the source itself (its title, date or version) is supported when it matches the source's metadata.
UNSUPPORTED: the claim adds a fact the sources don't state, or contradicts them.

SOURCES:
${sources.map((x, i) => `[${i + 1}] Title: ${x.title} · version ${x.version} · indexed ${String(x.indexedAt ?? "").slice(0, 10)}\n${x.excerpt}`).join("\n\n")}

CLAIM: ${claim}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(`${judgeCfg.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(judgeCfg.key ? { authorization: `Bearer ${judgeCfg.key}` } : {}) },
        body: JSON.stringify({ model: judgeCfg.model, temperature: 0, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      // A dropped connection or timeout is retried like a rate limit; after four tries the claim stays unjudged.
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    const j = await res.json();
    const out = String(j.choices?.[0]?.message?.content ?? "").toUpperCase();
    return out.includes("UNSUPPORTED") ? false : out.includes("SUPPORTED") ? true : null;
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sentences of the answer that carry citation markers, with the evidence ids they cite. */
function citedClaims(content) {
  return content
    .split(/\n+|(?<=[.!?])\s+(?=[A-ZА-Я0-9*•-])/)
    .map((s) => s.trim())
    .filter((s) => /\[\[(?:ev|lv)_[A-Za-z0-9_-]+\]\]/.test(s))
    .map((s) => ({
      ids: [...s.matchAll(/\[\[((?:ev|lv)_[A-Za-z0-9_-]+)\]\]/g)].map((m) => m[1]),
      text: s.replace(/\[\[[^\]]+\]\]/g, "").replace(/^[-*•]\s+/, "").replace(/\*\*/g, "").trim(),
    }))
    .filter((c) => c.text.length > 3);
}
const cyrillicShare = (s) => {
  const letters = s.replace(/\[\[[^\]]+\]\]/g, "").match(/\p{L}/gu) ?? [];
  return letters.length ? letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length / letters.length : 0;
};

// --- Run --------------------------------------------------------------------------------------------
const rows = [];
let model = "";
for (const q of questions) {
  const s = await as(q.principal);
  const conv = await s.req("POST", "/api/conversations", { agentId: AGENT });
  if (conv.status !== 201) throw new Error(`${q.id}: conversation ${conv.status} ${conv.text.slice(0, 200)}`);
  const t0 = performance.now();
  let r = await s.req("POST", `/api/conversations/${conv.json.id}/messages`, { content: q.question });
  if (r.status !== 201 || r.json?.assistantMessage?.status === "error") {
    await sleep(15_000); // a transient model error (rate limit, 5xx) is retried once, and reported
    const conv2 = await s.req("POST", "/api/conversations", { agentId: AGENT });
    r = await s.req("POST", `/api/conversations/${conv2.json.id}/messages`, { content: q.question });
  }
  const ms = Math.round(performance.now() - t0);
  const m = r.json?.assistantMessage ?? { status: `http_${r.status}`, content: r.text.slice(0, 300), citations: [] };
  model ||= m.model ? `${m.model.name} (${m.model.provider})` : "";
  const cited = (m.citations ?? []).filter((c) => c.kind !== "live");
  const citedDocs = [...new Set(cited.map((c) => c.documentId))];
  const support = supportingIds(q);
  const answered = m.status === "answered" || m.status === "action_proposed";
  const leaks = citedDocs.filter((d) => forbidden(q, d));
  const canary = q.principal !== "carol" && /CANARY-FL-/.test(JSON.stringify(m));

  let claims = [];
  if (JUDGE && answered) {
    const sourceOf = new Map((m.citations ?? []).map((c) => [c.evidenceId, { title: c.title ?? c.resourceId ?? "", version: c.version ?? "", indexedAt: c.indexedAt ?? c.readAt, excerpt: c.excerpt ?? "" }]));
    for (const c of citedClaims(m.content)) {
      const ok = await judge(c.text, c.ids.map((id) => sourceOf.get(id) ?? { title: "", version: "", excerpt: "" }));
      claims.push({ claim: c.text.slice(0, 200), supported: ok });
      await sleep(DELAY_MS / 2);
    }
  }
  rows.push({
    id: q.id,
    category: q.category,
    type: q.type,
    principal: q.principal,
    question: q.question,
    status: m.status,
    ms,
    answered,
    citesSupporting: support.length ? support.some((d) => citedDocs.includes(d)) : null,
    expectTextFound: q.expectText ? m.content.toLowerCase().includes(q.expectText.toLowerCase()) : null,
    bulgarianAnswer: q.language === "bg" && answered ? cyrillicShare(m.content) > 0.5 : null,
    leaks: [...leaks, ...(canary ? ["CANARY"] : [])],
    claims,
    citedDocs,
    answer: m.content.slice(0, 1500),
  });
  process.stdout.write(`${q.id} ${m.status} ${ms}ms${claims.length ? ` claims ${claims.filter((c) => c.supported).length}/${claims.length}` : ""}\n`);
  await sleep(DELAY_MS);
}

// --- Report -----------------------------------------------------------------------------------------
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 100);
const answerable = rows.filter((r) => r.type === "answerable");
const refusable = rows.filter((r) => r.type === "unanswerable");
const permission = rows.filter((r) => r.type === "permission");
const allClaims = rows.flatMap((r) => r.claims).filter((c) => c.supported !== null);
const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0;
const bg = rows.filter((r) => r.bulgarianAnswer !== null);
const summary = {
  date: new Date().toISOString(),
  label: LABEL,
  agent: AGENT,
  model,
  judge: JUDGE ? judgeCfg.model : "off",
  questions: rows.length,
  answerRate: pct(answerable.filter((r) => r.answered).length, answerable.length),
  citesSupporting: pct(answerable.filter((r) => r.answered && r.citesSupporting).length, answerable.filter((r) => r.answered && r.citesSupporting !== null).length),
  expectTextFound: pct(answerable.filter((r) => r.expectTextFound).length, answerable.filter((r) => r.expectTextFound !== null).length),
  citationSupport: pct(allClaims.filter((c) => c.supported).length, allClaims.length),
  claimsJudged: allClaims.length,
  abstention: pct(refusable.filter((r) => !r.answered).length, refusable.length),
  leakingAnswers: rows.filter((r) => r.leaks.length).length,
  permissionRefused: pct(permission.filter((r) => !r.answered || !r.leaks.length).length, permission.length),
  bulgarianAnswers: pct(bg.filter((r) => r.bulgarianAnswer).length, bg.length),
  latencyMs: { p50: q(0.5), p95: q(0.95), max: lat.at(-1) ?? 0 },
};
const gates = [
  ["Citation support (judged sentence by sentence)", "≥ 95%", `${summary.citationSupport}% of ${summary.claimsJudged}`, JUDGE ? summary.citationSupport >= 95 : null],
  ["Unanswerable questions refused", "100%", `${summary.abstention}%`, summary.abstention === 100],
  ["Answers leaking documents the asker can't read", "0", String(summary.leakingAnswers), summary.leakingAnswers === 0],
  ["Answerable questions answered", "≥ 90%", `${summary.answerRate}%`, summary.answerRate >= 90],
  ["Answered questions cite a supporting document", "≥ 90%", `${summary.citesSupporting}%`, summary.citesSupporting >= 90],
];
const byCategory = Object.entries(Object.groupBy(rows, (r) => r.category)).map(([c, rs]) => {
  const ok = (r) => (r.type === "answerable" ? r.answered && r.citesSupporting !== false : r.type === "unanswerable" ? !r.answered : !r.leaks.length);
  return `| ${c} | ${rs.length} | ${rs.filter(ok).length} |`;
});
const problems = rows.filter(
  (r) => (r.type === "answerable" && (!r.answered || r.citesSupporting === false)) || (r.type === "unanswerable" && r.answered) || r.leaks.length || r.claims.some((c) => c.supported === false) || r.bulgarianAnswer === false,
);
const md = `# Answer evaluation · ${LABEL} · ${summary.date.slice(0, 10)}

Model: **${model || "unknown"}** · assistant: ${AGENT} · judge: ${summary.judge} · ${rows.length} questions (synthetic)

## Gates

| Gate | Target | Measured | Result |
|---|---|---|---|
${gates.map(([g, t, m, ok]) => `| ${g} | ${t} | ${m} | ${ok === null ? "not run" : ok ? "pass" : "**fail**"} |`).join("\n")}

## Other measures

| Measure | Value |
|---|---|
| Answer contains the expected fact (where one is defined) | ${summary.expectTextFound}% |
| Bulgarian questions answered in Bulgarian | ${summary.bulgarianAnswers}% |
| Permission questions with no leak | ${summary.permissionRefused}% |
| Latency p50 / p95 / max | ${(summary.latencyMs.p50 / 1000).toFixed(1)} s / ${(summary.latencyMs.p95 / 1000).toFixed(1)} s / ${(summary.latencyMs.max / 1000).toFixed(1)} s |

## By category (questions that behaved as expected)

| Category | Questions | As expected |
|---|---|---|
${byCategory.join("\n")}

## Questions to look at

${
  problems.length
    ? problems
        .map(
          (r) =>
            `- **${r.id}** (${r.category}, ${r.principal}) “${r.question}” → ${r.status}${r.citesSupporting === false ? ", cites other documents" : ""}${r.leaks.length ? `, LEAK ${r.leaks.join(", ")}` : ""}${r.bulgarianAnswer === false ? ", not in Bulgarian" : ""}${r.claims
              .filter((c) => c.supported === false)
              .map((c) => `\n  - unsupported: “${c.claim}”`)
              .join("")}`,
        )
        .join("\n")
    : "None."
}
`;
await mkdir(`${ROOT}docs/eval`, { recursive: true });
const name = `${ROOT}docs/eval/${summary.date.slice(0, 10)}-answers-${LABEL}`;
await writeFile(`${name}.json`, JSON.stringify({ summary, gates, rows }, null, 2));
await writeFile(`${name}.md`, md);
console.log(`\n${md}\nwrote ${name}.{json,md}`);
process.exit(gates.every((g) => g[3] !== false) ? 0 : 1);
