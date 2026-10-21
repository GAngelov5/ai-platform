import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { TrackerStore, TrackerTask } from "./store.js";

export interface TrackerServerOptions {
  store: TrackerStore;
  /** Audience-bound bearer token issued to the platform for this server only. */
  token: string;
  /** Test hook: delay the response AFTER a write has been committed (simulates response loss). */
  postCommitDelayMs?: number;
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});

const view = (t: TrackerTask) => ({
  key: t.key,
  title: t.title,
  status: t.status,
  assignee: t.assignee,
  updatedAt: t.updatedAt,
  summary: t.summary,
  recentComments: t.comments.slice(-3).map((c) => ({ id: c.id, author: c.author, text: c.text, createdAt: c.createdAt })),
});

/** Tool definitions are stable: the platform pins a hash of each one. */
export function buildMcpServer(o: TrackerServerOptions): McpServer {
  const server = new McpServer({ name: "atlas-tracker", version: "1.0.0" });

  server.registerTool(
    "tasks_list",
    {
      description: "List tracker tasks (key, title, live status) for a project key such as ATLAS.",
      inputSchema: { project: z.string().min(1).max(32) },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => json({ project, tasks: o.store.list(project).map((t) => ({ key: t.key, title: t.title, status: t.status, updatedAt: t.updatedAt })) }),
  );

  server.registerTool(
    "task_status",
    {
      description: "Get the current live status, assignee, summary and recent comments of one tracker task by key, e.g. ATLAS-142.",
      inputSchema: { taskKey: z.string().regex(/^[A-Za-z]+-\d+$/) },
      annotations: { readOnlyHint: true },
    },
    async ({ taskKey }) => {
      const t = o.store.get(taskKey);
      if (!t) return { isError: true, content: [{ type: "text" as const, text: `unknown task ${taskKey}` }] };
      return json(view(t));
    },
  );

  server.registerTool(
    "task_add_comment",
    {
      description: "Add a comment to a tracker task. Idempotent per idempotencyKey.",
      inputSchema: {
        taskKey: z.string().regex(/^[A-Za-z]+-\d+$/),
        text: z.string().min(1).max(2000),
        idempotencyKey: z.string().uuid(),
        author: z.string().min(1).max(100),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ taskKey, text, idempotencyKey, author }) => {
      if (!o.store.get(taskKey)) return { isError: true, content: [{ type: "text" as const, text: `unknown task ${taskKey}` }] };
      const r = await o.store.addComment(taskKey, text, idempotencyKey, author);
      if (o.postCommitDelayMs) await new Promise((res) => setTimeout(res, o.postCommitDelayMs));
      return json({ commentId: r.comment.id, created: r.created, createdAt: r.comment.createdAt });
    },
  );

  server.registerTool(
    "task_find_comment",
    {
      description: "Look up a comment by idempotency key (used to reconcile uncertain write outcomes).",
      inputSchema: { taskKey: z.string().regex(/^[A-Za-z]+-\d+$/), idempotencyKey: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    async ({ taskKey, idempotencyKey }) => {
      const c = o.store.findComment(taskKey, idempotencyKey);
      return json(c ? { found: true, commentId: c.id, createdAt: c.createdAt } : { found: false });
    },
  );
  return server;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

/** Stateless Streamable HTTP MCP endpoint at POST /mcp, plus GET /health. */
export function createTrackerHttpServer(o: TrackerServerOptions): Server {
  return createHttpServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
        return;
      }
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (!authorized(req, o.token)) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const body = await readBody(req);
      const server = buildMcpServer(o);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });
}
