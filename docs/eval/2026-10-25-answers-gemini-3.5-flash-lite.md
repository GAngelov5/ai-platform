# Answer evaluation · gemini-3.5-flash-lite · 2026-10-25

Model: **gemini-3.5-flash-lite (openai-compatible:generativelanguage.googleapis.com)** · assistant: knowledge-assistant · judge: gemini-3.7-flash · 60 questions (synthetic)

## Gates

| Gate | Target | Measured | Result |
|---|---|---|---|
| Citation support (judged sentence by sentence) | ≥ 95% | 91.3% of 80 | **fail** |
| Unanswerable questions refused | 100% | 100% | pass |
| Answers leaking documents the asker can't read | 0 | 0 | pass |
| Answerable questions answered | ≥ 90% | 76.1% | **fail** |
| Answered questions cite a supporting document | ≥ 90% | 100% | pass |

## Other measures

| Measure | Value |
|---|---|
| Answer contains the expected fact (where one is defined) | 88.5% |
| Bulgarian questions answered in Bulgarian | 100% |
| Permission questions with no leak | 100% |
| Latency p50 / p95 / max | 1.8 s / 2.9 s / 3.1 s |

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
| paraphrase | 13 | 2 |
| multi-document | 4 | 4 |
| near-miss | 5 | 5 |
| bulgarian | 4 | 4 |

## Questions to look at

- **q14** (conflicting-versions, alice) “What is the current planned go-live date for Borealis?” → answered
  - unsupported: “The superseded version 1 had previously planned the go-live for 16 November 2026 .”
- **q15** (conflicting-versions, alice) “What is the current planned go-live date for Cedar?” → answered
  - unsupported: “This replaces version 1, which had previously planned the go-live for 2 December 2026 .”
- **q17** (conflicting-versions, alice) “What is the current planned go-live date for Ember?” → answered
  - unsupported: “The previous plan (version 1) had scheduled the go-live for 5 January 2027 .”
- **q22** (policy, bob) “What is the annual training budget per employee?” → answered
  - unsupported: “Each employee has an annual training budget of EUR 1,200 according to the training policy version 1792664788000-334 (indexed October 2022) .”
- **h01** (paraphrase, alice) “Why was the analytics platform held back in May 2026?” → insufficient_evidence, cites other documents
- **h02** (paraphrase, alice) “What slowed down the warehouse robots in April 2026?” → insufficient_evidence, cites other documents
- **h03** (paraphrase, alice) “When is the HR self-service launch now expected?” → insufficient_evidence, cites other documents
- **h04** (paraphrase, alice) “When will the field service app be launched?” → insufficient_evidence, cites other documents
- **h05** (paraphrase, alice) “How long can technicians keep working without a connection in the mobile app?” → insufficient_evidence, cites other documents
- **h06** (paraphrase, alice) “How long are raw billing records retained on the analytics platform?” → insufficient_evidence, cites other documents
- **h07** (paraphrase, alice) “How frequently are the encryption keys changed for the analytics data?” → answered
  - unsupported: “The encryption keys for analytics data are rotated every 90 days according to the technical specification (version 1792664788000-1110) .”
- **h08** (paraphrase, bob) “How much money do I get per day when travelling in Europe for work?” → insufficient_evidence, cites other documents
- **h09** (paraphrase, bob) “How long do I have to hand in receipts to get reimbursed?” → insufficient_evidence, cites other documents
- **h10** (paraphrase, bob) “Can I keep confidential company data on my own phone?” → insufficient_evidence, cites other documents
- **h12** (paraphrase, bob) “What should I do if I am ill and cannot come to work?” → insufficient_evidence, cites other documents
- **h13** (paraphrase, bob) “How many offers do I need before buying something expensive?” → insufficient_evidence, cites other documents
- **h14** (multi-document, alice) “How did the main Borealis blocker change between May and June 2026?” → answered
  - unsupported: “June 2026 (status 2026 06): The main blocker changed to an unresolved single sign-on integration with the reporting tool .”
- **h16** (multi-document, alice) “What did the Cedar steering committee decide about photo uploads, and how are Cedar maps refreshed?” → answered
  - unsupported: “The Cedar steering committee decided to compress photos on the device before upload , and Cedar maps are refreshed nightly from cached vector tiles .”
