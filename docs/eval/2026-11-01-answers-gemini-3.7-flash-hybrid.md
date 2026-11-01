# Answer evaluation · gemini-3.7-flash-hybrid · 2026-11-01

Model: **gemini-3.7-flash (openai-compatible:generativelanguage.googleapis.com)** · assistant: knowledge-assistant · judge: gemini-3.7-flash · 60 questions (synthetic)

## Gates

| Gate | Target | Measured | Result |
|---|---|---|---|
| Citation support (judged sentence by sentence) | ≥ 95% | 91.3% of 92 | **fail** |
| Unanswerable questions refused | 100% | 100% | pass |
| Answers leaking documents the asker can't read | 0 | 0 | pass |
| Answerable questions answered | ≥ 90% | 78.3% | **fail** |
| Answered questions cite a supporting document | ≥ 90% | 97.2% | pass |

## Other measures

| Measure | Value |
|---|---|
| Answer contains the expected fact (where one is defined) | 76.9% |
| Bulgarian questions answered in Bulgarian | 100% |
| Permission questions with no leak | 100% |
| Latency p50 / p95 / max | 9.8 s / 14.9 s / 15.0 s |

## By category (questions that behaved as expected)

| Category | Questions | As expected |
|---|---|---|
| status | 6 | 6 |
| decision | 4 | 4 |
| spec | 3 | 1 |
| conflicting-versions | 4 | 4 |
| policy | 6 | 6 |
| restricted | 3 | 3 |
| unanswerable | 5 | 5 |
| permission | 3 | 3 |
| paraphrase | 13 | 6 |
| multi-document | 4 | 4 |
| near-miss | 5 | 5 |
| bulgarian | 4 | 2 |

## Questions to look at

- **q06** (status, alice) “What was the main blocker for Dune in August 2026?” → answered
  - unsupported: “According to the August 2026 status report, the main blocker for Dune was supplier delays :”
- **q12** (spec, alice) “How does Dune handle network?” → insufficient_evidence, cites other documents
- **q13** (spec, alice) “How does Ember handle audit?” → insufficient_evidence, cites other documents
- **q14** (conflicting-versions, alice) “What is the current planned go-live date for Borealis?” → answered
  - unsupported: “According to the latest document from 2026-10-22, the planned go-live date for Borealis is 1 February 2027, though this information may be out of date .”
- **q15** (conflicting-versions, alice) “What is the current planned go-live date for Cedar?” → answered
  - unsupported: “Based on the latest available document, the current planned go-live date for Cedar is 10 March 2027, though this may be out of date .”
- **q16** (conflicting-versions, alice) “What is the current planned go-live date for Dune?” → answered
  - unsupported: “According to the latest document from 2026-10-22, the planned go-live date for Dune is 28 April 2027, though this may be out of date .”
- **q17** (conflicting-versions, alice) “What is the current planned go-live date for Ember?” → answered
  - unsupported: “Based on the latest document (dated 2026-10-22), the planned go-live date for Ember is 6 April 2027, though this document may be out of date .”
- **h02** (paraphrase, alice) “What slowed down the warehouse robots in April 2026?” → insufficient_evidence, cites other documents
- **h03** (paraphrase, alice) “When is the HR self-service launch now expected?” → insufficient_evidence, cites other documents
- **h04** (paraphrase, alice) “When will the field service app be launched?” → insufficient_evidence, cites other documents
- **h05** (paraphrase, alice) “How long can technicians keep working without a connection in the mobile app?” → insufficient_evidence, cites other documents
- **h06** (paraphrase, alice) “How long are raw billing records retained on the analytics platform?” → insufficient_evidence, cites other documents
- **h07** (paraphrase, alice) “How frequently are the encryption keys changed for the analytics data?” → insufficient_evidence, cites other documents
- **h10** (paraphrase, bob) “Can I keep confidential company data on my own phone?” → insufficient_evidence, cites other documents
- **h13** (paraphrase, bob) “How many offers do I need before buying something expensive?” → answered
  - unsupported: “According to the procurement policy dated 2026-10-22, expensive purchases require competing quotes .”
- **h15** (multi-document, alice) “Compare the original and the current go-live date for Dune.” → answered
  - unsupported: “Current go-live date: The current approved plan (version 2, dated 2026-10-22) sets the go-live for 28 April 2027, though this may be out of date .”
- **bg01** (bulgarian, alice) “Какъв е основният блокер на проекта Атлас?” → insufficient_evidence, cites other documents
- **bg02** (bulgarian, bob) “Колко дни платен годишен отпуск има служител на пълен работен ден?” → answered, cites other documents
  - unsupported: “Според политиката за отпуски от 2026-10-22 служител на пълен работен ден има право на 25 дни платен годишен отпуск .”
