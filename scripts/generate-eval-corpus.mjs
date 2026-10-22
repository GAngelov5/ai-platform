#!/usr/bin/env node
// Generates the synthetic evaluation corpus (stage 3b) and its labeled questions.
//
//   node scripts/generate-eval-corpus.mjs
//
// Output:
//   fixtures/sources/eval-corpus/**   documents (.md, .html, .pdf, .docx, image-only PDFs) + .acl.json files
//   fixtures/eval/questions.json      labeled questions with supporting files and permission expectations
// Everything is fictional. Deterministic content; re-running overwrites the folder.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "fixtures/sources/eval-corpus");
const QUESTIONS = join(ROOT, "fixtures/eval/questions.json");
const FIXED_DATE = new Date("2026-10-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------
const files = [];
async function put(rel, data) {
  const full = join(OUT, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  files.push(rel);
}
const md = (title, sections) => `# ${title}\n\n${sections.map(([h, t]) => `## ${h}\n${t}`).join("\n\n")}\n`;
const html = (title, sections) =>
  `<!doctype html><html><head><title>${title}</title><style>body{font-family:sans-serif}</style></head><body><h1>${title}</h1>${sections
    .map(([h, t]) => `<h2>${h}</h2><p>${t}</p>`)
    .join("")}</body></html>`;

async function pdf(title, sections) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]);
  let y = 790;
  const line = (text, f = font, size = 11) => {
    if (y < 60) {
      page = doc.addPage([595, 842]);
      y = 790;
    }
    page.drawText(text, { x: 50, y, size, font: f });
    y -= size + 6;
  };
  const wrap = (text) => {
    const words = text.split(" ");
    let cur = "";
    for (const w of words) {
      if (font.widthOfTextAtSize(`${cur} ${w}`, 11) > 490) {
        line(cur.trim());
        cur = "";
      }
      cur += ` ${w}`;
    }
    if (cur.trim()) line(cur.trim());
  };
  line(title, bold, 16);
  y -= 6;
  for (const [h, t] of sections) {
    line(h, bold, 13);
    wrap(t);
    y -= 6;
  }
  return Buffer.from(await doc.save());
}

/** A "scan": an image-only PDF with no text layer (should be quarantined as needs_ocr). */
async function scanPdf() {
  const doc = await PDFDocument.create();
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const page = doc.addPage([595, 842]);
  for (let i = 0; i < 24; i++) page.drawRectangle({ x: 50, y: 760 - i * 28, width: 300 + ((i * 37) % 180), height: 8, color: rgb(0.2, 0.2, 0.2) });
  return Buffer.from(await doc.save());
}

async function docx(title, sections) {
  const doc = new Document({
    creator: "Synthetic corpus",
    title,
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          ...sections.flatMap(([h, t]) => [new Paragraph({ text: h, heading: HeadingLevel.HEADING_2 }), new Paragraph({ text: t })]),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function emit(rel, title, sections) {
  const ext = rel.split(".").pop();
  if (ext === "md") return put(rel, md(title, sections));
  if (ext === "html") return put(rel, html(title, sections));
  if (ext === "pdf") return put(rel, await pdf(title, sections));
  if (ext === "docx") return put(rel, await docx(title, sections));
  throw new Error(`unknown extension ${ext}`);
}

// ---------------------------------------------------------------------------
// Synthetic facts
// ---------------------------------------------------------------------------
const MONTHS = [
  ["2026-04", "April 2026"],
  ["2026-05", "May 2026"],
  ["2026-06", "June 2026"],
  ["2026-07", "July 2026"],
  ["2026-08", "August 2026"],
  ["2026-09", "September 2026"],
];
const FORMATS = ["md", "docx", "pdf", "md", "html", "docx"];

const PROJECTS = [
  {
    key: "borealis",
    name: "Borealis",
    what: "the analytics data platform",
    vendor: "Kestrel Systems",
    blockers: [
      "late delivery of the ingestion cluster hardware",
      "schema drift in the billing exports",
      "an unresolved single sign-on integration with the reporting tool",
      "insufficient storage throughput in the staging environment",
      "a data retention policy review by the privacy office",
      "capacity planning for the year-end reporting peak",
    ],
    decisions: [
      ["data retention", "keep raw billing events for 400 days and aggregates for seven years"],
      ["dashboard tooling", "standardise on one dashboard tool and retire the two legacy ones"],
      ["on-call", "move platform on-call from weekly to fortnightly rotations"],
      ["cost allocation", "charge storage costs back to consuming departments from Q1 2027"],
    ],
    specs: [
      ["query engine", "Borealis uses a columnar query engine with a shared metadata catalog for interactive queries"],
      ["ingestion", "Borealis ingests billing exports every 15 minutes through a change-data-capture pipeline"],
      ["encryption", "Borealis encrypts data at rest with keys rotated every 90 days by the key management service"],
    ],
    goLive: ["16 November 2026", "1 February 2027"],
  },
  {
    key: "cedar",
    name: "Cedar",
    what: "the field service mobile app",
    vendor: "Lumen Apps",
    blockers: [
      "app store review rejection of the location permissions text",
      "offline sync conflicts on shared work orders",
      "battery drain caused by continuous GPS tracking",
      "a missing translation review for the German release",
      "accessibility findings on the work order screen",
      "push notification delays on older Android devices",
    ],
    decisions: [
      ["offline mode", "support a full offline mode for up to 72 hours"],
      ["device support", "drop support for operating systems older than five years"],
      ["release cadence", "ship mobile releases every three weeks"],
      ["photo uploads", "compress photos on the device before upload"],
    ],
    specs: [
      ["push notifications", "Cedar uses a managed push gateway that batches notifications per technician"],
      ["offline storage", "Cedar stores work orders offline in an encrypted on-device database"],
      ["maps", "Cedar renders maps from cached vector tiles refreshed nightly"],
    ],
    goLive: ["2 December 2026", "10 March 2027"],
  },
  {
    key: "dune",
    name: "Dune",
    what: "the warehouse automation programme",
    vendor: "Orbit Robotics",
    blockers: [
      "a safety certification delay for the autonomous carts",
      "Wi-Fi dead zones in aisle 14 to 22",
      "conveyor firmware incompatibility with the scanner gateway",
      "union consultation on revised shift patterns",
      "spare parts lead times from the cart vendor",
      "a fire inspection of the new charging area",
    ],
    decisions: [
      ["charging", "install the cart charging area on the mezzanine level"],
      ["pilot scope", "limit the pilot to the small-parts zone for the first eight weeks"],
      ["safety", "require a human spotter for cart moves near loading docks"],
      ["maintenance", "contract on-site vendor maintenance for the first year"],
    ],
    specs: [
      ["fleet management", "Dune coordinates carts through a fleet manager that assigns missions every two seconds"],
      ["network", "Dune requires a private 5G network for cart telemetry"],
      ["integration", "Dune integrates with the warehouse management system through a message queue"],
    ],
    goLive: ["15 January 2027", "28 April 2027"],
  },
  {
    key: "ember",
    name: "Ember",
    what: "the HR self-service system",
    vendor: "Harbor HR Cloud",
    blockers: [
      "a payroll interface defect for part-time contracts",
      "missing approval workflows for parental leave",
      "data migration of historical absence records",
      "a works council review of the performance module",
      "integration testing with the time-tracking system",
      "training material translation for the Dutch offices",
    ],
    decisions: [
      ["performance reviews", "postpone the performance module to phase two"],
      ["absence history", "migrate only the last three years of absence history"],
      ["mobile access", "allow mobile access to payslips with step-up authentication"],
      ["support", "route HR system questions through the shared service desk"],
    ],
    specs: [
      ["identity", "Ember signs users in through the corporate identity provider with group-based roles"],
      ["payroll", "Ember exports payroll changes to the payroll provider once per working day"],
      ["audit", "Ember keeps an immutable audit trail of every change to employee records"],
    ],
    goLive: ["5 January 2027", "6 April 2027"],
  },
];

const POLICIES = [
  ["travel-policy.md", "Travel policy", [["Per diem", "The daily per diem for business travel within the EU is EUR 45. Hotels must be booked through the travel desk."], ["Flights", "Economy class is standard for flights under six hours."]]],
  ["expense-policy.html", "Expense policy", [["Receipts", "Expense claims above EUR 25 require an itemised receipt."], ["Deadline", "Submit expense claims within 60 days of the expense."]]],
  ["password-policy.pdf", "Password policy", [["Rotation", "Passwords for privileged accounts must be rotated every 180 days."], ["Length", "Passwords must have at least 14 characters."]]],
  ["leave-policy.docx", "Annual leave policy", [["Entitlement", "Full-time employees receive 25 days of annual leave per calendar year."], ["Carry-over", "Up to five unused days may be carried over to the next year."]]],
  ["remote-work-policy.md", "Remote work policy", [["Office days", "Employees may work remotely up to three days per week."], ["Equipment", "A one-off home office allowance of EUR 300 is available."]]],
  ["training-policy.html", "Training and development policy", [["Budget", "Each employee has an annual training budget of EUR 1,200."], ["Approval", "Courses above the budget need director approval."]]],
  ["incident-reporting.pdf", "Security incident reporting", [["Timing", "Report suspected security incidents to the security office within 4 hours of discovery."], ["Channel", "Use the incident hotline outside office hours."]]],
  ["data-classification.docx", "Data classification standard", [["Levels", "Data is classified as public, internal, confidential or restricted."], ["Restricted data", "Restricted data may not be stored on personal devices."]]],
  ["visitor-policy.md", "Visitor policy", [["Registration", "Visitors must be registered at reception 24 hours in advance."], ["Escort", "Visitors must be escorted in secure areas."]]],
  ["parking-policy.html", "Parking policy", [["Permits", "Parking permits are renewed every January."], ["Electric vehicles", "Charging bays are limited to four hours per day."]]],
  ["code-of-conduct.pdf", "Code of conduct", [["Gifts", "Gifts from suppliers above EUR 50 must be declared."], ["Conflicts", "Declare potential conflicts of interest to your manager."]]],
  ["it-onboarding.md", "IT onboarding guide", [["First day", "New starters receive their laptop and badge on the first morning."], ["Accounts", "Accounts are created three working days before the start date."]]],
  ["sick-leave-policy.docx", "Sick leave policy", [["Notification", "Notify your manager before 9:00 on the first day of sickness."], ["Certificate", "A medical certificate is needed after three consecutive days."]]],
  ["procurement-policy.html", "Procurement policy", [["Quotes", "Purchases above EUR 10,000 require three competing quotes."], ["Approval", "Purchase orders are approved in the procurement system."]]],
  ["whistleblowing.pdf", "Whistleblowing policy", [["Channel", "Concerns can be raised anonymously through the ethics line."], ["Protection", "Reporters acting in good faith are protected from retaliation."]]],
  ["mobile-phone-policy.md", "Mobile phone policy", [["Eligibility", "Company phones are provided to roles with on-call duties."], ["Roaming", "Roaming must be enabled before travel outside the EU."]]],
  ["recycling-guide.html", "Office recycling guide", [["Batteries", "Used batteries go in the red box at reception."], ["Paper", "Confidential paper goes in the locked shredding bins."]]],
  ["meeting-room-guide.md", "Meeting room guide", [["Booking", "Meeting rooms can be booked up to four weeks ahead."], ["No-shows", "Bookings are released after 15 minutes without check-in."]]],
  ["wellbeing-programme.docx", "Wellbeing programme", [["Sports", "The company contributes EUR 30 per month to a gym membership."], ["Counselling", "Six free counselling sessions are available per year."]]],
  ["holiday-calendar.pdf", "Office holiday calendar 2027", [["Closures", "The offices are closed between Christmas and New Year."], ["Floating day", "Each employee has one floating holiday to choose."]]],
];

const NEWS = Array.from({ length: 15 }, (_, i) => [
  `newsletters/newsletter-${String(i + 1).padStart(2, "0")}.${i % 2 ? "html" : "md"}`,
  `Company newsletter issue ${i + 1}`,
  [
    ["Around the office", `Issue ${i + 1} covers the canteen menu rotation, the running club and photos from the summer event.`],
    ["People", `Welcome to the colleagues who joined this month in issue ${i + 1}, and thanks to the volunteers.`],
  ],
]);

const FINANCE = PROJECTS.flatMap((p, i) => [
  [
    `${p.key}-contract.pdf`,
    `${p.name} contract summary`,
    [["Value", `CANARY-FL-${p.key.toUpperCase()}: The ${p.name} contract with ${p.vendor} has a total value of EUR ${(1.2 + i * 0.7).toFixed(1)} million.`], ["Penalties", `A late-delivery penalty of ${3 + i}% applies per month of delay.`]],
  ],
  [`${p.key}-budget.docx`, `${p.name} budget 2027`, [["Budget", `CANARY-FL-${p.key.toUpperCase()}: The approved ${p.name} budget for 2027 is EUR ${(800 + i * 150).toFixed(0)} thousand.`], ["Contingency", `Contingency is ${8 + i}% of the budget.`]]],
  [`${p.key}-legal-review.md`, `${p.name} legal review`, [["Findings", `CANARY-FL-${p.key.toUpperCase()}: Legal review found the ${p.vendor} liability cap acceptable at ${1 + i} times the annual fee.`]]],
]);

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------
await rm(OUT, { recursive: true, force: true });
await put(".acl.json", JSON.stringify({ groups: ["CORP\\Everyone"] }, null, 2));
await put("projects/.acl.json", JSON.stringify({ groups: ["CORP\\Project Teams"] }, null, 2));
await put("finance-legal/.acl.json", JSON.stringify({ groups: ["CORP\\Finance and Legal"] }, null, 2));

for (const p of PROJECTS) {
  for (const [m, [ym, label]] of MONTHS.entries()) {
    await emit(`projects/${p.key}/status-${ym}.${FORMATS[m]}`, `${p.name} status report ${label}`, [
      ["Summary", `${p.name} is ${p.what}. Overall progress in ${label} reached ${40 + m * 10} percent.`],
      ["Main blocker", `In ${label} the main blocker for ${p.name} was ${p.blockers[m]}.`],
    ]);
  }
  for (const [k, [topic, decision]] of p.decisions.entries()) {
    await emit(`projects/${p.key}/steering-minutes-${k + 1}.docx`, `${p.name} steering committee minutes ${k + 1}`, [
      ["Attendees", `The ${p.name} steering committee met with the vendor ${p.vendor}.`],
      ["Decision", `On ${topic}, the ${p.name} steering committee decided to ${decision}.`],
    ]);
  }
  for (const [k, [topic, fact]] of p.specs.entries()) {
    await emit(`projects/${p.key}/spec-${topic.replace(/\s+/g, "-")}.pdf`, `${p.name} technical specification: ${topic}`, [["Design", `${fact}.`]]);
  }
  await emit(`projects/${p.key}/go-live-plan-v1.md`, `${p.name} go-live plan (version 1, superseded)`, [
    ["Status", "This version is superseded by version 2."],
    ["Go-live", `Version 1 planned the ${p.name} go-live for ${p.goLive[0]}.`],
  ]);
  await emit(`projects/${p.key}/go-live-plan-v2.md`, `${p.name} go-live plan (version 2, current)`, [
    ["Status", "This is the current approved plan."],
    ["Go-live", `The current plan sets the ${p.name} go-live for ${p.goLive[1]}.`],
  ]);
}
for (const [file, title, sections] of POLICIES) await emit(`policies/${file}`, title, sections);
for (const [file, title, sections] of NEWS) await emit(file, title, sections);
for (const [file, title, sections] of FINANCE) await emit(`finance-legal/${file}`, title, sections);
for (let i = 1; i <= 3; i++) await put(`scans/scanned-form-${i}.pdf`, await scanPdf());

// ---------------------------------------------------------------------------
// Labeled questions
// ---------------------------------------------------------------------------
const P = Object.fromEntries(PROJECTS.map((p) => [p.key, p]));
const statusFile = (k, m) => files.find((f) => f.startsWith(`projects/${k}/status-${MONTHS[m][0]}.`));
const q = [];
const add = (o) => q.push({ id: `q${String(q.length + 1).padStart(2, "0")}`, ...o });

for (const [k, m] of [["borealis", 1], ["cedar", 2], ["dune", 0], ["ember", 3], ["cedar", 5], ["dune", 4]]) {
  add({ principal: "alice", type: "answerable", category: "status", question: `What was the main blocker for ${P[k].name} in ${MONTHS[m][1]}?`, supporting: [statusFile(k, m)], expectText: P[k].blockers[m].split(" ").slice(0, 3).join(" ") });
}
for (const [k, d] of [["borealis", 0], ["cedar", 2], ["dune", 1], ["ember", 2]]) {
  add({ principal: "alice", type: "answerable", category: "decision", question: `What did the ${P[k].name} steering committee decide about ${P[k].decisions[d][0]}?`, supporting: [`projects/${k}/steering-minutes-${d + 1}.docx`], expectText: P[k].decisions[d][1].split(" ").slice(0, 3).join(" ") });
}
for (const [k, s] of [["cedar", 0], ["dune", 1], ["ember", 2]]) {
  const topic = P[k].specs[s][0];
  add({ principal: "alice", type: "answerable", category: "spec", question: `How does ${P[k].name} handle ${topic}?`, supporting: [`projects/${k}/spec-${topic.replace(/\s+/g, "-")}.pdf`], expectText: P[k].specs[s][1].split(" ").slice(1, 4).join(" ") });
}
for (const k of ["borealis", "cedar", "dune", "ember"]) {
  add({ principal: "alice", type: "answerable", category: "conflicting-versions", question: `What is the current planned go-live date for ${P[k].name}?`, supporting: [`projects/${k}/go-live-plan-v2.md`], superseded: [`projects/${k}/go-live-plan-v1.md`], expectText: P[k].goLive[1] });
}
for (const [file, question, expect] of [
  ["policies/travel-policy.md", "What is the daily per diem for business travel within the EU?", "EUR 45"],
  ["policies/password-policy.pdf", "How often must passwords for privileged accounts be rotated?", "180 days"],
  ["policies/incident-reporting.pdf", "Within how many hours must a suspected security incident be reported?", "4 hours"],
]) add({ principal: "alice", type: "answerable", category: "policy", question, supporting: [file], expectText: expect });
for (const [file, question, expect] of [
  ["policies/leave-policy.docx", "How many days of annual leave do full-time employees receive?", "25 days"],
  ["policies/training-policy.html", "What is the annual training budget per employee?", "EUR 1,200"],
  ["policies/remote-work-policy.md", "How many days per week may employees work remotely?", "three days"],
]) add({ principal: "bob", type: "answerable", category: "policy", question, supporting: [file], expectText: expect });
for (const [file, question] of [
  ["finance-legal/borealis-contract.pdf", "What is the total value of the Borealis contract with Kestrel Systems?"],
  ["finance-legal/dune-budget.docx", "What is the approved Dune budget for 2027?"],
  ["finance-legal/ember-legal-review.md", "What liability cap did the legal review accept for Harbor HR Cloud?"],
]) add({ principal: "carol", type: "answerable", category: "restricted", question, supporting: [file] });
for (const question of [
  "What is the Borealis marketing budget for 2029?",
  "Which football club sponsors the Cedar app?",
  "What is the per diem for travel to the Moon?",
  "Who won the Dune hackathon in 2025?",
  "What is the Ember share price target?",
]) add({ principal: "alice", type: "unanswerable", category: "unanswerable", question, supporting: [] });
add({ principal: "bob", type: "permission", category: "permission", question: "What was the main blocker for Borealis in May 2026?", supporting: [], mustNotRetrievePrefixes: ["projects/", "finance-legal/"] });
add({ principal: "alice", type: "permission", category: "permission", question: "What is the total value of the Borealis contract with Kestrel Systems?", supporting: [], mustNotRetrievePrefixes: ["finance-legal/"] });
add({ principal: "bob", type: "permission", category: "permission", question: "What is the approved Dune budget for 2027?", supporting: [], mustNotRetrievePrefixes: ["finance-legal/", "projects/"] });

const readable = {
  alice: ["policies/", "newsletters/", "scans/", "projects/"],
  bob: ["policies/", "newsletters/", "scans/"],
  carol: ["policies/", "newsletters/", "scans/", "projects/", "finance-legal/"],
};

await mkdir(dirname(QUESTIONS), { recursive: true });
await writeFile(
  QUESTIONS,
  JSON.stringify(
    {
      $comment: "Generated by scripts/generate-eval-corpus.mjs. Synthetic and fictional.",
      sourceId: "eval-corpus",
      corpusFiles: files.filter((f) => !f.endsWith(".acl.json")).length,
      readablePrefixes: readable,
      questions: q,
    },
    null,
    2,
  ) + "\n",
);

// The team-share "architecture diagram" is a scan without a text layer.
await writeFile(join(ROOT, "fixtures/sources/team-share/atlas/architecture-diagram.pdf"), await scanPdf());

console.log(`wrote ${files.length} files to ${OUT} and ${q.length} questions to ${QUESTIONS}`);
