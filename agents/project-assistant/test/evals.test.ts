/**
 * Labeled synthetic evaluation of the Project Assistant through the real
 * runtime, policy-enforcing knowledge service and fixture adapter, with the
 * deterministic FAKE model. This measures retrieval + grounding plumbing, not
 * the quality of any real language model.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentRuntime, FakeModelGateway } from "@platform/ai";
import { FixtureKnowledgeAdapter, loadFixtureCorpus, PolicyEnforcingKnowledgeService, type IssuedEvidence } from "@platform/knowledge";
import { createTrustedContext, type Principal } from "@platform/security";
import { projectAssistant } from "../src/index.js";

const evals = JSON.parse(readFileSync(new URL("../evals/questions.json", import.meta.url), "utf8")) as {
  cases: { id: string; principal: string; question: string; expect: string; supportingDocuments: string[]; mustMention: string[]; mustNotContain: string[] }[];
};
const identities = JSON.parse(readFileSync(new URL("../../../fixtures/identities.json", import.meta.url), "utf8")) as {
  customer: { id: string };
  principals: { principalId: string; displayName: string; groups: string[] }[];
};
const FIXTURES = fileURLToPath(new URL("../../../fixtures/documents", import.meta.url));
const CUSTOMER = identities.customer.id;

async function world() {
  const corpus = await loadFixtureCorpus(FIXTURES);
  const catalog = corpus.map((d) => ({ ...d, customerId: CUSTOMER, aclRevision: 1, externalRef: {}, tombstoned: false }));
  const principals = new Map<string, Principal>(
    identities.principals.map((p) => [p.principalId, { id: p.principalId, customerId: CUSTOMER, displayName: p.displayName, groups: p.groups, roles: [], disabled: false }]),
  );
  const ledger = new Map<string, IssuedEvidence>();
  const model = new FakeModelGateway();
  const knowledge = new PolicyEnforcingKnowledgeService({
    catalog: {
      listReadable: async (_c, groups, sources) => catalog.filter((d) => sources.includes(d.sourceId) && d.aclGroups.some((g) => groups.includes(g))),
      get: async (_c, id) => catalog.find((d) => d.documentId === id),
    },
    principals: { get: async (_c, id) => principals.get(id) },
    ledger: { record: async (rows) => rows.forEach((r) => ledger.set(r.evidenceId, r)), get: async (_c, id) => ledger.get(id) },
    adapter: new FixtureKnowledgeAdapter(corpus),
    policySourceIds: projectAssistant.knowledgeScopes.sourceIds,
  });
  const runtime = new AgentRuntime({ knowledge, model, runs: { start: async () => "run", finish: async () => {} } });
  return { runtime, model };
}

describe("Project Assistant labeled fixture evals (fake model)", () => {
  for (const c of evals.cases) {
    it(`${c.id}: ${c.question} as ${c.principal}`, async () => {
      const { runtime, model } = await world();
      const ctx = createTrustedContext({ customerId: CUSTOMER, principalId: c.principal, policyVersion: "eval" });
      const r = await runtime.run(ctx, { agent: projectAssistant, question: c.question });
      expect(r.status).toBe(c.expect);
      const cited = new Set(r.citations.map((x) => x.documentId));
      for (const d of c.supportingDocuments) expect(cited, `expected citation of ${d}`).toContain(d);
      for (const m of c.mustMention) expect(r.content).toContain(m);
      const everything = JSON.stringify(r) + JSON.stringify(model.calls);
      for (const m of c.mustNotContain) expect(everything).not.toContain(m);
      if (c.expect === "insufficient_evidence") expect(r.citations).toEqual([]);
    });
  }
});
