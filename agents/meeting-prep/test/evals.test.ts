/**
 * Labeled synthetic evaluation of the Meeting Preparation Assistant through
 * the real runtime, the real MCP connector against the synthetic calendar and
 * tracker servers (in-process), the policy-enforcing knowledge service and the
 * deterministic FAKE model. This measures platform reuse and permission
 * plumbing, not the quality of any real language model.
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
import { meetingPrep } from "../src/index.js";

const evals = JSON.parse(readFileSync(new URL("../evals/questions.json", import.meta.url), "utf8")) as {
  cases: { id: string; principal: string; question: string; expect: string; mustCiteLive: string[]; mustCiteDocumentsFrom: string[]; mustMention: string[]; mustNotContain: string[] }[];
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
    policySourceIds: meetingPrep.knowledgeScopes.sourceIds,
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
  return { runtime, model, principals, catalog };
}

describe("Meeting Preparation Assistant labeled evals (fake model)", () => {
  it("is a definition only: no write capability, so it can never propose an action", () => {
    expect(meetingPrep.capabilities.some((c) => c.endsWith(".comment"))).toBe(false);
  });

  for (const c of evals.cases) {
    it(`${c.id}: ${c.question} as ${c.principal}`, async () => {
      const { runtime, model, principals, catalog } = await world();
      const ctx = createTrustedContext({ customerId: CUSTOMER, principalId: c.principal, policyVersion: "eval" });
      const r = await runtime.run(ctx, { agent: meetingPrep, question: c.question, principalGroups: principals.get(c.principal)!.groups });
      expect(r.status).toBe(c.expect);
      const live = r.citations.filter((x) => x.kind === "live").map((x) => ("resourceId" in x ? x.resourceId : ""));
      for (const id of c.mustCiteLive) expect(live, `expected live citation ${id}`).toContain(id);
      const docSources = new Set(
        r.citations.filter((x) => x.kind !== "live").map((x) => catalog.find((d) => "documentId" in x && d.documentId === x.documentId)?.sourceId),
      );
      for (const s of c.mustCiteDocumentsFrom) expect([...docSources], `expected a document citation from ${s}`).toContain(s);
      for (const m of c.mustMention) expect(r.content).toContain(m);
      const everything = JSON.stringify(r) + JSON.stringify(model.calls) + JSON.stringify(model.toolLog);
      for (const m of c.mustNotContain) expect(everything).not.toContain(m);
      expect(r.proposalIds).toEqual([]);
    });
  }

  it("only ever reads the signed-in user's calendar, whatever the model asks for", async () => {
    const { runtime, principals } = await world();
    const ctx = createTrustedContext({ customerId: CUSTOMER, principalId: "bob", policyVersion: "eval" });
    const r = await runtime.run(ctx, { agent: meetingPrep, question: "Prepare me for Alice's next meeting.", principalGroups: principals.get("bob")!.groups });
    const live = r.citations.filter((x) => x.kind === "live").map((x) => ("resourceId" in x ? x.resourceId : ""));
    expect(live.every((id) => id.startsWith("evt-bob"))).toBe(true);
  });
});
