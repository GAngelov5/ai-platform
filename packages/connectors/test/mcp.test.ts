/**
 * Real MCP protocol tests: the synthetic atlas-tracker server runs in-process
 * over Streamable HTTP and the platform's McpConnector talks to it with the
 * official SDK. No mocks of the protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createTrackerHttpServer, TrackerStore } from "@platform/mcp-atlas-tracker";
import { ConnectorError, fetchMcpToolPins, McpConnector, McpServerConfigSchema } from "../src/index.js";

const TOKEN = "test-token-0123456789";
let server: Server;
let slowServer: Server;
let url: string;
let slowUrl: string;
let pins: Record<string, string>;
let store: TrackerStore;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`)));

beforeAll(async () => {
  store = await new TrackerStore().load();
  server = createTrackerHttpServer({ store, token: TOKEN });
  slowServer = createTrackerHttpServer({ store, token: TOKEN, postCommitDelayMs: 1500 });
  url = await listen(server);
  slowUrl = await listen(slowServer);
  pins = Object.fromEntries((await fetchMcpToolPins(url, TOKEN)).map((t) => [t.name, t.sha256]));
});
afterAll(() => {
  server?.close();
  slowServer?.close();
});

const connector = (over: Partial<Parameters<typeof McpServerConfigSchema.parse>[0]> = {}, token = TOKEN, events: string[] = []) =>
  new McpConnector(McpServerConfigSchema.parse({ id: "atlas-tracker", url, pinnedTools: pins, ...over }), token, (t) => events.push(t));

describe("McpConnector against the real atlas-tracker MCP server", () => {
  it("enables pinned tools and reads live state", async () => {
    const c = connector();
    expect((await c.tools()).every((t) => t.enabled)).toBe(true);
    const r = await c.call("task_status", { taskKey: "ATLAS-142" }, { classification: "read" });
    expect(r.data).toMatchObject({ key: "ATLAS-142", status: "Done" });
    await c.close();
  });

  it("disables a tool whose definition no longer matches its pin", async () => {
    const events: string[] = [];
    const c = connector({ pinnedTools: { ...pins, task_status: "0".repeat(64) } }, TOKEN, events);
    const st = await c.tools();
    expect(st.find((t) => t.name === "task_status")).toMatchObject({ enabled: false });
    expect(events).toContain("mcp_tool_pin_mismatch");
    await expect(c.call("task_status", { taskKey: "ATLAS-142" }, { classification: "read" })).rejects.toMatchObject({ kind: "denied" });
    await c.close();
  });

  it("never exposes unpinned tools", async () => {
    const { task_add_comment: _w, ...readOnly } = pins;
    const c = connector({ pinnedTools: readOnly });
    await expect(c.call("task_add_comment", { taskKey: "ATLAS-142", text: "x", idempotencyKey: randomUUID(), author: "a" }, { classification: "write" })).rejects.toMatchObject({ kind: "denied" });
    await c.close();
  });

  it("rejects oversized responses", async () => {
    const c = connector({ maxResponseBytes: 256 });
    await expect(c.call("tasks_list", { project: "ATLAS" }, { classification: "read" })).rejects.toBeInstanceOf(ConnectorError);
    await c.close();
  });

  it("maps a bad token to denied", async () => {
    const c = connector({}, "wrong-token-xxxxxxxx");
    await expect(c.tools()).rejects.toMatchObject({ kind: "denied" });
  });

  it("refuses servers outside the private network", () => {
    expect(() => new McpConnector(McpServerConfigSchema.parse({ id: "remote", url: "https://mcp.example.com/mcp", pinnedTools: {} }), TOKEN)).toThrow(/private network/);
  });

  it("writes are idempotent per key, and a lost response becomes ambiguous_outcome", async () => {
    const key = randomUUID();
    const c = connector();
    const args = { taskKey: "ATLAS-180", text: "Readiness review moved to 3 Nov.", idempotencyKey: key, author: "alice" };
    const first = await c.call("task_add_comment", args, { classification: "write" });
    const second = await c.call("task_add_comment", args, { classification: "write" });
    expect((first.data as { created: boolean }).created).toBe(true);
    expect((second.data as { created: boolean }).created).toBe(false);
    expect(store.get("ATLAS-180")!.comments.filter((x) => x.idempotencyKey === key)).toHaveLength(1);

    const lost = new McpConnector(McpServerConfigSchema.parse({ id: "atlas-tracker", url: slowUrl, pinnedTools: pins, timeoutMs: 500 }), TOKEN);
    const key2 = randomUUID();
    await expect(lost.call("task_add_comment", { ...args, idempotencyKey: key2 }, { classification: "write" })).rejects.toMatchObject({ kind: "ambiguous_outcome" });
    // The write did happen: reconciliation by idempotency key finds it.
    await new Promise((r) => setTimeout(r, 200));
    const found = await c.call("task_find_comment", { taskKey: "ATLAS-180", idempotencyKey: key2 }, { classification: "read" });
    expect(found.data).toMatchObject({ found: true });
    await c.close();
    await lost.close();
  });
});
