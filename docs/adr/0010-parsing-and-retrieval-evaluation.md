# ADR 0010 — Document parsing in isolation, and the retrieval evaluation gate

Status: accepted (Stage 3b) · Date: 2026-10-22 · Builds on ADR 0003, 0006 and 0009

## Questions

1. How are PDF and DOCX files turned into text without letting a hostile or
   broken file take the ingestion worker down?
2. How do we know that a knowledge backend is good enough, and safe enough,
   before a pilot? (Handoff §3: the knowledge selection gate.)

## Decision 1 — Parse binary formats in an isolated worker thread

- **PDF:** `unpdf` 1.8.1 (pdf.js text extraction). **DOCX:** `mammoth` 1.13.0,
  converted to HTML and then to text with headings preserved.
- Both run in a `worker_threads` worker (`parse-worker.mjs`) with
  `resourceLimits` (256 MB heap) and a 20 s timeout. A parser crash, an
  out-of-memory error or a hang ends only that worker. The document goes to
  quarantine with a reason: `parse_error`, `parse_timeout` or `needs_ocr`.
- **Scans:** a PDF with almost no text layer (< 20 characters) is
  quarantined as `needs_ocr`. It is never indexed half-empty. OCR is a
  later decision (see open questions).
- Both libraries are pure JavaScript, so the images need no native toolchain
  and no extra service.

A worker thread is a resource boundary, not a security sandbox: it shares the
process and its file system. The production hardening option is a separate
parser container with no network and a read-only file system, behind the same
`parseDocument()` contract. Apache Tika and docling are candidates for that
container.

## Decision 2 — A repeatable retrieval evaluation gates every backend

- **Corpus:** `scripts/generate-eval-corpus.mjs` deterministically writes 110
  synthetic files to `fixtures/sources/eval-corpus`:
  - Markdown, HTML, DOCX, text PDFs and three image-only "scans"
  - four projects, policies, newsletters and a finance/legal folder with
    canary strings
  - two go-live plan versions per project: v1 marked superseded, v2 current
  - permissions inherited from `.acl.json` files, in native group names
- **Questions:** `fixtures/eval/questions.json`, 34 in total:
  - 26 answerable, 4 of which have conflicting versions
  - 5 unanswerable
  - 3 permission probes, where a principal asks for content they may not read
- **Harness:** `scripts/eval-retrieval.mjs` runs over the real HTTP API with
  dev sign-in, so the measured path includes `PolicyEnforcingKnowledgeService`
  and the ACL prefilter. It writes `docs/eval/<date>-<label>.{md,json}` and
  exits non-zero if a gate fails.
- **Gates** (handoff §3, proposed pilot gates):
  - top-5 recall ≥ 85%
  - unanswerable questions abstain: 100%
  - zero unauthorized passages
  - citation support ≥ 95%. This needs model answers, so it is measured
    separately; see "Not covered".
- The eval corpus is opt-in (`KNOWLEDGE_INCLUDE_EVAL_CORPUS=true`, or the
  `compose.lightrag-eval.yaml` overlay). Configuration refuses it when
  `APP_ENV=production`.

## Decision 3 — Version handling lives in the platform, not in the backend

The first lexical run ranked every superseded go-live plan **above** its
current version (0% current-first). The platform now does this itself, so the
behavior is the same for every backend:

- `supersededVersions()` groups documents into version families by file name:
  same source, same base name, `-vN` suffix. Every lower N maps to the
  highest one.
- It runs over the documents **the principal may read**. A newer version
  they cannot read is never named and never demotes their copy.
- In `KnowledgeService.search`, superseded chunks are moved after the current
  ones with a stable sort. Otherwise the backend's order and scores are kept.
  The evidence carries `supersededBy`, and the model sees `superseded: true`
  with the instruction to prefer current versions.
- A first version of this halved superseded scores instead. That was
  rejected for two reasons: it re-sorted every result by score, overriding
  the backend's own order, and it pushed old versions below the agent's 0.6
  evidence threshold. The model would then never see v1, even for questions
  like "what changed since v1?".

Systems with native versioning (SharePoint, Confluence) only expose the
current version, so this rule does not touch them. A source adapter can
later provide explicit version metadata instead of the naming convention.

## Results

| Run | Recall@5 | Abstention (proxy) | False abstention | Current version first | Leaks | Latency p50 / p95 |
|---|---|---|---|---|---|---|
| Lexical, before version handling | 100% | 80% | 0% | 0% | 0 | 152 / 190 ms |
| Lexical, with version handling ([report](../eval/2026-10-22-lexical.md)) | 100% | 80% | 0% | 100% | 0 | 145 / 185 ms |
| LightRAG, lexical re-ranking (default, [report](../eval/2026-10-22-lightrag.md)) | 100% | 80% | 0% | 100% | 0 | 132 / 222 ms* |
| LightRAG, native ranking ([report](../eval/2026-10-22-lightrag-native.md)) | 100% | 80% | 0% | 100% | 0 | 126 / 208 ms* |

\* With LightRAG's query cache warm. The first, uncached run measured p95
13.4 s and max 22.7 s, because LightRAG extracts query keywords with the LLM
on CPU. That run was cut short by an Ollama runner crash, so it has no full
report.

**How to read the LightRAG rows.** LightRAG's `/query/data` returns chunks
without a relevance score. The adapter therefore scores each chunk by
query-term overlap, and by default also orders by it (lexical re-ranking of
LightRAG's candidates). `LIGHTRAG_RANKING=native` keeps LightRAG's own order,
and only the evidence threshold uses the overlap score. Both modes pass, so
LightRAG's candidate selection and its own ranking are each good enough on
this corpus.

**This corpus does not tell backends apart.** All three runs reach 100%
recall, because the synthetic questions reuse distinctive document words:
project names, months, policy names. Choosing a backend needs a harder
question set:
- paraphrases and synonyms ("go-live" vs "launch", "blocker" vs
  "impediment")
- questions that need two documents
- more near-miss questions like q29

That set is the next eval step, before real data.

**Abstention cannot be tuned out of a score threshold.** The remaining failure
is q29, "What is the per diem for travel to the Moon?". It matches the travel
policy on three of its four terms (score 0.75), which is higher than several
legitimate questions (0.67). IDF-weighted scoring was tried: the Moon
question still scored 0.67, and six answerable questions fell below the
threshold (false abstention 0% → 23%). It was reverted.

Conclusion: the evidence-score threshold filters noise. Refusing a
near-miss question is the model's job: it has to read the travel policy and
state that it covers no Moon travel. That is measured with model answers,
together with citation support.

## Not covered (yet)

- **Citation support and model-level abstention.** These need real model
  answers over the 34 questions. On CPU, `qwen3:4b` takes 2–6 minutes per
  answer, so this waits for the model and hardware decision in ROADMAP.
- **OCR** for the three scans.
- **Partition scale.** The eval corpus produced only the three existing
  access sets, so it does not answer this question.
- **Backend discrimination.** See "How to read the LightRAG rows": a
  paraphrase question set is needed.

## Open questions

- Should OCR be self-hosted (Tesseract in the parser container, or docling),
  or done by the RAG backend?
- A separate parser container: is it needed for the pilot, or only once
  sources hold untrusted uploads?
