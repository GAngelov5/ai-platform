/**
 * Labeled synthetic evaluation of the core Knowledge Assistant through the
 * real runtime and policy-enforcing knowledge service, with the tracker and
 * calendar connectors REGISTERED (in-process MCP servers) and the
 * deterministic FAKE model. It shows that the core agent stays documents-only
 * even where live tools exist. Not a measure of any real language model.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { AgentRuntime, FakeModelGateway } from "@platform/ai";
import { CapabilityRegistry } from "@platform/agents";
import { fetchMcpToolPins, McpConnector, McpServerConfigSchema, registerAtlasTrackerCapabilities, registerCalendarCapabilities } from "@platform/connectors";
import { FixtureKnowledgeAdapter, loadFixtureCorpus, PolicyEnforcingKnowledgeService, type IssuedEvidence } from "@platform/knowledge";
import { CalendarStore, createTrackerHttpServer, TrackerStore } from "@platform/mcp-atlas-tracker";
import { createTrustedContext, type Principal } from "@platform/security";
import { knowledgeAssistant } from "../src/index.js";

const evals = JSON.parse(readFileSync(new URL("../evals/questions.json", import.meta.url), "utf8")) as {
  cases: { id: string; principal: string; question: string; expect: string; supportingDocuments: string[]; mustMention: string[]; mustNotContain: string[] }[];
};
const identities = JSON.parse(readFileSync(new URL("../../../fixtures/identities.json", import.meta.url), "utf8")) as {
  customer: { id: string };
  principals: { principalId: string; displayName: string; groups: string[] }[];
};
const FIXTURES = fileURLToPath(new URL("../../../fixtures/documents", import.meta.url));
const CUSTOMER = identities.customer.id;
const TRACKER_TOKEN = "tracker-token-0123456789";
const CALENDAR_TOKEN = "calendar-token-0123456789";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createTrackerHttpServer({
    store: await new TrackerStore().load(),
    token: TRACKER_TOKEN,
    calendar: { store: new CalendarStore(), token: CALENDAR_TOKEN },
  });
  base = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
});
afterAll(() => server?.close());

async function world() {
  const corpus = await loadFixtureCorpus(FIXTURES);
  const catalog = corpus.map((d) => ({ ...d, customerId: CUSTOMER, aclRevision: 1, externalRef: {}, tombstoned: false }));
  const principals = new Map<string, Principal>(
    identities.principals.map((p) => [p.principalId, { id: p.principalId, customerId: CUSTOMER, displayName: p.displayName, groups: p.groups, roles: [], disabled: false }]),
  );
  const ledger = new Map<string, IssuedEvidence>();
  const knowledge = new PolicyEnforcingKnowledgeService({
    catalog: {
      listReadable: async (_c, groups, sources) => catalog.filter((d) => sources.includes(d.sourceId) && d.aclGroups.some((g) => groups.includes(g))),
      get: async (_c, id) => catalog.find((d) => d.documentId === id),
    },
    principals: { get: async (_c, id) => principals.get(id) },
    ledger: { record: async (rows) => rows.forEach((r) => ledger.set(r.evidenceId, r)), get: async (_c, id) => ledger.get(id) },
    adapter: new FixtureKnowledgeAdapter(corpus),
    policySourceIds: ["atlas-project-docs", "company-handbook", "team-share"],
  });
  const capabilities = new CapabilityRegistry();
  const connector = async (id: string, url: string, token: string) =>
    new McpConnector(
      McpServerConfigSchema.parse({ id, url, pinnedTools: Object.fromEntries((await fetchMcpToolPins(url, token)).map((t) => [t.name, t.sha256])) }),
      token,
    );
  registerCalendarCapabilities(capabilities, await connector("calendar", `${base}/calendar/mcp`, CALENDAR_TOKEN));
  registerAtlasTrackerCapabilities(capabilities, await connector("atlas-tracker", `${base}/mcp`, TRACKER_TOKEN));
  const model = new FakeModelGateway();
  const runtime = new AgentRuntime({ knowledge, model, runs: { start: async () => "run", finish: async () => {} }, capabilities });
  return { runtime, model, principals };
}

describe("Knowledge Assistant (core) labeled evals (fake model)", () => {
  it("is documents-only: no live and no write capability", () => {
    expect([...knowledgeAssistant.capabilities]).toEqual(["knowledge.search"]);
  });

  for (const c of evals.cases) {
    it(`${c.id}: ${c.question} as ${c.principal}`, async () => {
      const { runtime, model, principals } = await world();
      const ctx = createTrustedContext({ customerId: CUSTOMER, principalId: c.principal, policyVersion: "eval" });
      const r = await runtime.run(ctx, { agent: knowledgeAssistant, question: c.question, principalGroups: principals.get(c.principal)!.groups });
      if (c.expect !== "any") expect(r.status).toBe(c.expect);
      const cited = new Set(r.citations.map((x) => ("documentId" in x ? x.documentId : x.resourceId)));
      for (const d of c.supportingDocuments) expect(cited, `expected citation of ${d}`).toContain(d);
      for (const m of c.mustMention) expect(r.content).toContain(m);
      const everything = JSON.stringify(r) + JSON.stringify(model.calls);
      for (const m of c.mustNotContain) expect(everything).not.toContain(m);
      if (c.expect === "insufficient_evidence") expect(r.citations).toEqual([]);
      // Whatever the question, the model is offered documents only, and nothing live is read or proposed.
      expect(model.calls.flatMap((call) => (call.tools ?? []).map((t) => t.name))).toEqual(model.calls.map(() => "knowledge_search"));
      expect(model.toolLog.every((t) => t === "knowledge_search")).toBe(true);
      expect(r.citations.some((x) => x.kind === "live")).toBe(false);
      expect(r.proposalIds).toEqual([]);
    });
  }
});
