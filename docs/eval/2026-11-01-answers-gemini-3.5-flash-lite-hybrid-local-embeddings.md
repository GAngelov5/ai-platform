# Answer evaluation · gemini-3.5-flash-lite-hybrid-local-embeddings · 2026-11-01

Model: **gemini-3.5-flash-lite (openai-compatible:generativelanguage.googleapis.com)** · assistant: knowledge-assistant · judge: gemini-3.7-flash · 60 questions (synthetic)

## Gates

| Gate | Target | Measured | Result |
|---|---|---|---|
| Citation support (judged sentence by sentence) | ≥ 95% | 93.3% of 104 | **fail** |
| Unanswerable questions refused | 100% | 100% | pass |
| Answers leaking documents the asker can't read | 0 | 0 | pass |
| Answerable questions answered | ≥ 90% | 97.8% | pass |
| Answered questions cite a supporting document | ≥ 90% | 100% | pass |

## Other measures

| Measure | Value |
|---|---|
| Answer contains the expected fact (where one is defined) | 96.2% |
| Bulgarian questions answered in Bulgarian | 100% |
| Permission questions with no leak | 100% |
| Latency p50 / p95 / max | 1.7 s / 2.8 s / 3.7 s |

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
| paraphrase | 13 | 12 |
| multi-document | 4 | 4 |
| near-miss | 5 | 5 |
| bulgarian | 4 | 4 |

## Questions to look at

- **q16** (conflicting-versions, alice) “What is the current planned go-live date for Dune?” → answered
  - unsupported: “The current approved plan sets the Dune go-live date to 28 April 2027 .”
- **h02** (paraphrase, alice) “What slowed down the warehouse robots in April 2026?” → answered
  - unsupported: “According to the April 2026 Dune status report (file of 2026-10-22), the main blocker for the warehouse automation programme was a safety certification delay for the autonomous carts .”
- **h03** (paraphrase, alice) “When is the HR self-service launch now expected?” → insufficient_evidence, cites other documents
- **h04** (paraphrase, alice) “When will the field service app be launched?” → answered
  - unsupported: “The field service mobile app (Cedar) is scheduled to go live on 10 March 2027 .”
- **h05** (paraphrase, alice) “How long can technicians keep working without a connection in the mobile app?” → answered
  - unsupported: “Technicians can keep working in full offline mode in the mobile app for up to 72 hours, as decided by the Cedar steering committee in October 2026 .”
  - unsupported: “Technicians are supported in full offline mode for up to 72 hours .”
- **h06** (paraphrase, alice) “How long are raw billing records retained on the analytics platform?” → answered
  - unsupported: “Raw billing records are retained on the analytics platform for 400 days according to the Borealis steering committee decision .”
- **h14** (multi-document, alice) “How did the main Borealis blocker change between May and June 2026?” → answered
  - unsupported: “In June 2026, the main blocker changed to an unresolved single sign-on integration with the reporting tool .”
