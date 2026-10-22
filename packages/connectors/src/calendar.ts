import { z } from "zod";
import type { CapabilityRegistry, LiveReadResult } from "@platform/agents";
import type { Connector } from "./types.js";

interface CalendarEventData {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  agenda: string;
}

/**
 * Capability bindings for a calendar MCP server (the synthetic one now; the
 * Microsoft Graph calendar later). The calendar owner is always the signed-in
 * principal: the model chooses only the time window.
 */
export function registerCalendarCapabilities(registry: CapabilityRegistry, connector: Connector): void {
  registry.register({
    definition: {
      id: "calendar.events.list",
      version: "1.0.0",
      kind: "read",
      description: "List YOUR upcoming meetings (title, time, location, attendees, agenda) for the next N days (1-14). Use this to find the meeting to prepare for.",
      input: z.strictObject({ days: z.number().int().min(1).max(14) }),
      requiredGroups: [],
      timeoutMs: 15_000,
      connectorId: connector.id,
    },
    healthy: async () => {
      try {
        return (await connector.tools()).some((t) => t.enabled);
      } catch {
        return false;
      }
    },
    read: async (input, { signal, principal }): Promise<LiveReadResult[]> => {
      const r = await connector.call("events_list", { owner: principal.principalId, days: Number(input.days) }, { classification: "read", signal });
      const events = ((r.data as { events?: unknown[] })?.events ?? []) as CalendarEventData[];
      return events.slice(0, 20).map((e) => ({ resourceId: e.id, title: `${e.title} (${e.start})`, data: e }));
    },
  });
}
