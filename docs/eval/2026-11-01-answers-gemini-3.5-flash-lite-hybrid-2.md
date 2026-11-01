# Answer evaluation · gemini-3.5-flash-lite-hybrid-2 · 2026-11-01

Model: **gemini-3.5-flash-lite (openai-compatible:generativelanguage.googleapis.com)** · assistant: knowledge-assistant · judge: gemini-3.7-flash · 60 questions (synthetic)

## Gates

| Gate | Target | Measured | Result |
|---|---|---|---|
| Citation support (judged sentence by sentence) | ≥ 95% | 96.8% of 95 | pass |
| Unanswerable questions refused | 100% | 100% | pass |
| Answers leaking documents the asker can't read | 0 | 0 | pass |
| Answerable questions answered | ≥ 90% | 89.1% | **fail** |
| Answered questions cite a supporting document | ≥ 90% | 100% | pass |

## Other measures

| Measure | Value |
|---|---|
| Answer contains the expected fact (where one is defined) | 88.5% |
| Bulgarian questions answered in Bulgarian | 100% |
| Permission questions with no leak | 100% |
| Latency p50 / p95 / max | 2.3 s / 5.1 s / 7.7 s |

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
| paraphrase | 13 | 8 |
| multi-document | 4 | 4 |
| near-miss | 5 | 5 |
| bulgarian | 4 | 4 |

## Questions to look at

- **h01** (paraphrase, alice) “Why was the analytics platform held back in May 2026?” → answered
  - unsupported: “The main blocker for the Borealis platform in May 2026 was schema drift in the billing exports .”
- **h02** (paraphrase, alice) “What slowed down the warehouse robots in April 2026?” → insufficient_evidence, cites other documents
- **h03** (paraphrase, alice) “When is the HR self-service launch now expected?” → insufficient_evidence, cites other documents
- **h04** (paraphrase, alice) “When will the field service app be launched?” → answered
  - unsupported: “The field service mobile app (Cedar) is planned to go live on 10 March 2027, according to the current go-live plan (version 2) .”
- **h05** (paraphrase, alice) “How long can technicians keep working without a connection in the mobile app?” → insufficient_evidence, cites other documents
- **h06** (paraphrase, alice) “How long are raw billing records retained on the analytics platform?” → answered
  - unsupported: “Raw billing records are retained on the analytics platform for 400 days, according to the Borealis steering committee decision from October 2026 .”
- **h10** (paraphrase, bob) “Can I keep confidential company data on my own phone?” → insufficient_evidence, cites other documents
- **h11** (paraphrase, bob) “How much does the company pay towards my gym?” → insufficient_evidence, cites other documents
