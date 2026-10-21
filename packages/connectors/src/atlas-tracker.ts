import { z } from "zod";
import type { CapabilityRegistry, LiveReadResult } from "@platform/agents";
import type { Connector } from "./types.js";

/**
 * Capability bindings for the synthetic Atlas tracker MCP server. These are
 * the platform's own capability definitions; the server's tools are reached
 * only through them, with platform-side input schemas and policy.
 */
export const ATLAS_TRACKER_GROUPS = ["atlas-team"] as const;

const TaskKey = z.string().trim().regex(/^[A-Za-z]+-\d+$/, "task key like ATLAS-142");

export function registerAtlasTrackerCapabilities(registry: CapabilityRegistry, connector: Connector): void {
  const healthy = async () => {
    try {
      return (await connector.tools()).some((t) => t.enabled);
    } catch {
      return false;
    }
  };

  registry.register({
    definition: {
      id: "tracker.tasks.list",
      version: "1.0.0",
      kind: "read",
      description: "List LIVE tracker tasks (key, title, current status) for a project key such as ATLAS. Use this to find task keys.",
      input: z.strictObject({ project: z.string().trim().min(2).max(32) }),
      requiredGroups: ATLAS_TRACKER_GROUPS,
      timeoutMs: 15_000,
      connectorId: connector.id,
    },
    healthy,
    read: async (input, { signal }): Promise<LiveReadResult[]> => {
      const r = await connector.call("tasks_list", { project: String(input.project) }, { classification: "read", signal });
      const tasks = ((r.data as { tasks?: unknown[] })?.tasks ?? []) as { key: string; title: string; status: string; updatedAt: string }[];
      return tasks.slice(0, 25).map((t) => ({ resourceId: t.key, title: t.title, data: t }));
    },
  });

  registry.register({
    definition: {
      id: "tracker.task.status",
      version: "1.0.0",
      kind: "read",
      description: "Get the CURRENT live status, assignee, summary and recent comments of one tracker task by key (e.g. ATLAS-142).",
      input: z.strictObject({ taskKey: TaskKey }),
      requiredGroups: ATLAS_TRACKER_GROUPS,
      timeoutMs: 15_000,
      connectorId: connector.id,
    },
    healthy,
    read: async (input, { signal }) => {
      const r = await connector.call("task_status", { taskKey: String(input.taskKey).toUpperCase() }, { classification: "read", signal });
      const t = r.data as { key: string; title: string };
      return [{ resourceId: t.key, title: t.title, data: r.data }];
    },
  });

  registry.register({
    definition: {
      id: "tracker.task.comment",
      version: "1.0.0",
      kind: "write",
      description:
        "PROPOSE adding a comment to a tracker task. This never executes directly: it creates a proposal the user must approve. Only use when the user explicitly asks to add a comment.",
      input: z.strictObject({ taskKey: TaskKey, text: z.string().trim().min(1).max(1000) }),
      requiredGroups: ATLAS_TRACKER_GROUPS,
      timeoutMs: 15_000,
      connectorId: connector.id,
    },
    healthy,
    write: {
      connectorId: connector.id,
      tool: "task_add_comment",
      describe: (input) => ({
        operation: `Add comment to tracker task ${String(input.taskKey).toUpperCase()}`,
        destination: `${connector.id} / ${String(input.taskKey).toUpperCase()}`,
        risk: "Visible to everyone with access to the task. Cannot be edited or removed by the assistant after posting.",
      }),
      toConnectorArgs: (input, meta) => ({
        taskKey: String(input.taskKey).toUpperCase(),
        text: String(input.text),
        idempotencyKey: meta.idempotencyKey,
        author: meta.principalDisplayName,
      }),
      reconcile: async (read, args) => {
        const r = (await read("task_find_comment", { taskKey: args.taskKey, idempotencyKey: args.idempotencyKey })) as { found?: boolean; commentId?: string; createdAt?: string };
        return r?.found ? { commentId: r.commentId, createdAt: r.createdAt, reconciled: true } : undefined;
      },
      receipt: (result) => {
        const r = result as { commentId?: string; created?: boolean; createdAt?: string };
        return { commentId: r?.commentId, created: r?.created, createdAt: r?.createdAt };
      },
    },
  });
}
