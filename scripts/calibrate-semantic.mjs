#!/usr/bin/env node
// Calibrates the semantic evidence score (ADR 0010) from eval reports run with
// EVIDENCE_SCORING=semantic SEMANTIC_SCORE_FLOOR=0 SEMANTIC_SCORE_CEIL=1, where
// each question's maxScore is the raw cosine of its best evidence.
//
//   node scripts/calibrate-semantic.mjs docs/eval/<date>-calib-lightrag-hard.json [more reports...]
//
// The threshold t is chosen on the FIRST report (the calibration set); the
// others are shown as hold-out checks. Then floor/ceil map t to the agent's
// minEvidenceScore (0.6) and the best answerable cosine to 1.
import { readFile } from "node:fs/promises";

const MIN_EVIDENCE_SCORE = 0.6;
const reports = await Promise.all(process.argv.slice(2).map(async (p) => ({ path: p, ...JSON.parse(await readFile(p, "utf8")) })));
if (!reports.length) throw new Error("usage: calibrate-semantic.mjs <calibration report> [hold-out reports...]");

const split = (r) => ({
  answerable: r.rows.filter((x) => x.type === "answerable").map((x) => x.maxScore),
  unanswerable: r.rows.filter((x) => x.type === "unanswerable").map((x) => x.maxScore),
});
const rates = ({ answerable, unanswerable }, t) => ({
  answered: answerable.filter((s) => s >= t).length / answerable.length,
  refused: unanswerable.length ? unanswerable.filter((s) => s < t).length / unanswerable.length : 1,
});
const pct = (x) => `${Math.round(x * 1000) / 10}%`;

const calib = split(reports[0]);
let best = { t: 0, sum: -1 };
for (let t = 0.3; t <= 0.9001; t += 0.005) {
  const r = rates(calib, t);
  // Answering correctly and refusing correctly weigh the same; ties go to the lower threshold (fewer false refusals).
  if (r.answered + r.refused > best.sum + 1e-9) best = { t: Math.round(t * 1000) / 1000, sum: r.answered + r.refused };
}
const t = best.t;
const top = Math.max(...calib.answerable);
const width = (top - t) / (1 - MIN_EVIDENCE_SCORE);
const floor = Math.round((t - MIN_EVIDENCE_SCORE * width) * 1000) / 1000;
const ceil = Math.round(top * 1000) / 1000;

console.log(`threshold (cosine) t = ${t}   → SEMANTIC_SCORE_FLOOR=${floor} SEMANTIC_SCORE_CEIL=${ceil}`);
console.log("");
console.log("| Report | Answerable cosine (min / median / max) | Unanswerable cosine (min / max) | Answered at t | Refused at t |");
console.log("|---|---|---|---|---|");
for (const r of reports) {
  const s = split(r);
  const sorted = [...s.answerable].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const rr = rates(s, t);
  const un = s.unanswerable.length ? `${Math.min(...s.unanswerable)} / ${Math.max(...s.unanswerable)}` : "—";
  console.log(`| ${r.summary.label} | ${sorted[0]} / ${med} / ${sorted.at(-1)} | ${un} | ${pct(rr.answered)} | ${pct(rr.refused)} |`);
}
