import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface CalendarEvent {
  id: string;
  /** Platform principal ID of the calendar owner (a mailbox in a real system). */
  owner: string;
  title: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  agenda: string;
}

/** Synthetic personal calendars, relative to "now" so the next meeting is always upcoming. */
export function seedCalendar(now: Date): CalendarEvent[] {
  const at = (days: number, hour: number, minutes = 0) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, hour, minutes));
    return d.toISOString();
  };
  return [
    {
      id: "evt-alice-1",
      owner: "alice",
      title: "Atlas steering committee",
      start: at(1, 9),
      end: at(1, 10),
      location: "Room Fjord / video",
      attendees: ["Alice", "Atlas programme manager", "Security office", "Northwind Payments"],
      agenda: "1. Go-live readiness (ATLAS-180). 2. Penetration test status (ATLAS-171). 3. Customer data migration sign-off. 4. Risks and decisions needed.",
    },
    {
      id: "evt-alice-2",
      owner: "alice",
      title: "1:1 with Bob",
      start: at(2, 13),
      end: at(2, 13, 30),
      location: "Video",
      attendees: ["Alice", "Bob"],
      agenda: "Weekly catch-up.",
    },
    {
      id: "evt-bob-1",
      owner: "bob",
      title: "Office relocation Q&A",
      start: at(1, 14),
      end: at(1, 15),
      location: "Canteen",
      attendees: ["Bob", "Facilities", "All staff"],
      agenda: "Questions about the office move: dates, parking, equipment and desk booking.",
    },
    {
      id: "evt-carol-1",
      owner: "carol",
      title: "Atlas budget and contract review",
      start: at(1, 11),
      end: at(1, 12),
      location: "Room Delta",
      attendees: ["Carol", "Finance controller", "Legal counsel"],
      agenda: "Atlas budget variance and the vendor contract terms from the latest legal memo.",
    },
  ];
}

/** Events are derived from "now" on every read, so a long-running service never runs out of upcoming meetings. */
export class CalendarStore {
  constructor(
    private readonly seed: (now: Date) => CalendarEvent[] = seedCalendar,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Upcoming events of one owner within `days`, earliest first. */
  upcoming(owner: string, days: number): CalendarEvent[] {
    const now = this.now();
    const from = now.getTime();
    const to = from + days * 24 * 60 * 60 * 1000;
    return this.seed(now)
      .filter((e) => e.owner === owner && Date.parse(e.end) >= from && Date.parse(e.start) <= to)
      .sort((a, b) => a.start.localeCompare(b.start));
  }
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});

/**
 * Read-only calendar MCP server. `owner` is supplied by the platform from the
 * signed-in principal (never by the model), like a delegated mailbox token.
 */
export function buildCalendarMcpServer(store: CalendarStore): McpServer {
  const server = new McpServer({ name: "calendar", version: "1.0.0" });
  server.registerTool(
    "events_list",
    {
      description: "List the owner's upcoming calendar events (title, time, location, attendees, agenda) within the next N days.",
      inputSchema: { owner: z.string().min(1).max(100), days: z.number().int().min(1).max(14) },
      annotations: { readOnlyHint: true },
    },
    async ({ owner, days }) => json({ owner, events: store.upcoming(owner, days) }),
  );
  return server;
}
