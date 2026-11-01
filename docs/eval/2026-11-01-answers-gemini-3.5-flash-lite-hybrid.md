# Answer evaluation · gemini-3.5-flash-lite-hybrid · 2026-11-01

Model: **gemini-3.5-flash-lite (openai-compatible:generativelanguage.googleapis.com)** · assistant: knowledge-assistant · judge: gemini-3.7-flash · 60 questions (synthetic)

## Gates

| Gate | Target | Measured | Result |
|---|---|---|---|
| Citation support (judged sentence by sentence) | ≥ 95% | 100% of 92 | pass |
| Unanswerable questions refused | 100% | 100% | pass |
| Answers leaking documents the asker can't read | 0 | 0 | pass |
| Answerable questions answered | ≥ 90% | 87% | **fail** |
| Answered questions cite a supporting document | ≥ 90% | 100% | pass |

## Other measures

| Measure | Value |
|---|---|
| Answer contains the expected fact (where one is defined) | 92.3% |
| Bulgarian questions answered in Bulgarian | 100% |
| Permission questions with no leak | 100% |
| Latency p50 / p95 / max | 2.3 s / 4.5 s / 4.9 s |

## By category (questions that behaved as expected)

| Category | Questions | As expected |
|---|---|---|
| status | 6 | 6 |
| decision | 4 | 4 |
| spec | 3 | 3 |
| conflicting-versions | 4 | 4 |
| policy | 6 | 6 |
| restricted | 3 | 3 |
| unanswerable | 5 | 5 |
| permission | 3 | 3 |
| paraphrase | 13 | 7 |
| multi-document | 4 | 4 |
| near-miss | 5 | 5 |
| bulgarian | 4 | 4 |

## Questions to look at

- **h02** (paraphrase, alice) “What slowed down the warehouse robots in April 2026?” → insufficient_evidence, cites other documents
- **h03** (paraphrase, alice) “When is the HR self-service launch now expected?” → insufficient_evidence, cites other documents
- **h05** (paraphrase, alice) “How long can technicians keep working without a connection in the mobile app?” → insufficient_evidence, cites other documents
- **h07** (paraphrase, alice) “How frequently are the encryption keys changed for the analytics data?” → insufficient_evidence, cites other documents
- **h11** (paraphrase, bob) “How much does the company pay towards my gym?” → insufficient_evidence, cites other documents
- **h13** (paraphrase, bob) “How many offers do I need before buying something expensive?” → insufficient_evidence, cites other documents
