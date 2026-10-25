# Answer evaluation · gemini-3.5-flash-lite-run2 · 2026-10-25

Model: **gemini-3.5-flash-lite (openai-compatible:generativelanguage.googleapis.com)** · assistant: knowledge-assistant · judge: gemini-3.7-flash · 60 questions (synthetic)

## Gates

| Gate | Target | Measured | Result |
|---|---|---|---|
| Citation support (judged sentence by sentence) | ≥ 95% | 90.2% of 82 | **fail** |
| Unanswerable questions refused | 100% | 100% | pass |
| Answers leaking documents the asker can't read | 0 | 0 | pass |
| Answerable questions answered | ≥ 90% | 78.3% | **fail** |
| Answered questions cite a supporting document | ≥ 90% | 100% | pass |

## Other measures

| Measure | Value |
|---|---|
| Answer contains the expected fact (where one is defined) | 88.5% |
| Bulgarian questions answered in Bulgarian | 100% |
| Permission questions with no leak | 100% |
| Latency p50 / p95 / max | 2.1 s / 3.5 s / 3.5 s |

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
| paraphrase | 13 | 4 |
| multi-document | 4 | 3 |
| near-miss | 5 | 5 |
| bulgarian | 4 | 4 |

## Questions to look at

- **q10** (decision, alice) “What did the Ember steering committee decide about mobile access?” → answered
  - unsupported: “Step-up authentication is required .”
- **q14** (conflicting-versions, alice) “What is the current planned go-live date for Borealis?” → answered
  - unsupported: “The previous plan (version 1) had targeted 16 November 2026 .”
- **q16** (conflicting-versions, alice) “What is the current planned go-live date for Dune?” → answered
  - unsupported: “The superseded version 1 had planned it for 15 January 2027 .”
- **q17** (conflicting-versions, alice) “What is the current planned go-live date for Ember?” → answered
  - unsupported: “The previous plan (version 1) had set the go-live date for 5 January 2027 .”
  - unsupported: “The updated plan (version 2) rescheduled it to 6 April 2027 .”
- **h01** (paraphrase, alice) “Why was the analytics platform held back in May 2026?” → insufficient_evidence, cites other documents
- **h02** (paraphrase, alice) “What slowed down the warehouse robots in April 2026?” → insufficient_evidence, cites other documents
- **h03** (paraphrase, alice) “When is the HR self-service launch now expected?” → insufficient_evidence, cites other documents
- **h04** (paraphrase, alice) “When will the field service app be launched?” → insufficient_evidence, cites other documents
- **h05** (paraphrase, alice) “How long can technicians keep working without a connection in the mobile app?” → insufficient_evidence, cites other documents
- **h06** (paraphrase, alice) “How long are raw billing records retained on the analytics platform?” → answered
  - unsupported: “Raw billing events on the Borealis analytics platform are retained for 400 days according to the steering committee decision .”
- **h08** (paraphrase, bob) “How much money do I get per day when travelling in Europe for work?” → insufficient_evidence, cites other documents
- **h10** (paraphrase, bob) “Can I keep confidential company data on my own phone?” → insufficient_evidence, cites other documents
- **h11** (paraphrase, bob) “How much does the company pay towards my gym?” → insufficient_evidence, cites other documents
- **h13** (paraphrase, bob) “How many offers do I need before buying something expensive?” → insufficient_evidence, cites other documents
- **h14** (multi-document, alice) “How did the main Borealis blocker change between May and June 2026?” → answered
  - unsupported: “In June 2026, the main blocker changed to an unresolved single sign-on integration with the reporting tool .”
- **h15** (multi-document, alice) “Compare the original and the current go-live date for Dune.” → insufficient_evidence, cites other documents
- **h17** (multi-document, carol) “What is the Ember budget for 2027, and what liability cap did legal accept for Ember's vendor?” → answered
  - unsupported: “Legal review accepted the liability cap for Harbor HR Cloud (Ember's vendor) at 4 times the annual fee .”
