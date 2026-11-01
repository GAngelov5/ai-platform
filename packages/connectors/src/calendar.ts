import { z } from "zod";
import type { CapabilityRegistry, LiveReadResult } from "@platform/agents";
import type { Connector } from "./types.js";
import type { CreateEventArgs } from "./google.js";

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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};
/** Calendar arithmetic on local values ("YYYY-MM-DD[THH:MM]"), independent of the server's own zone. */
const asUtc = (v: string) => new Date(`${v.length === 10 ? `${v}T00:00` : v}:00Z`);
const fromUtc = (d: Date, withTime: boolean) => d.toISOString().slice(0, withTime ? 16 : 10);
const realDate = (v: string) => !Number.isNaN(asUtc(v).getTime()) && fromUtc(asUtc(v), v.length > 10) === v;

export const CreateEventInput = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    start: z.string().trim().refine((v) => (DATE.test(v) || DATE_TIME.test(v)) && realDate(v), "YYYY-MM-DD for all day, or YYYY-MM-DDTHH:MM"),
    end: z.string().trim().refine((v) => (DATE.test(v) || DATE_TIME.test(v)) && realDate(v), "same form as start").optional(),
    timeZone: z.string().trim().max(64).refine(validZone, "an IANA time zone such as Europe/Sofia").optional(),
    description: z.string().trim().max(2000).optional(),
    location: z.string().trim().max(300).optional(),
    attendees: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.end && v.end.length !== v.start.length) ctx.addIssue({ code: "custom", path: ["end"], message: "end must be a date if start is, or a date and time if start is" });
  });

/** The event as it will be created: defaults applied, so the approval card and the payload agree exactly. */
export function normalizeEvent(input: Record<string, unknown>, defaultTimeZone: string) {
  const v = CreateEventInput.parse(input);
  const allDay = v.start.length === 10;
  // All day: the user's end date is inclusive; Google's is exclusive. Timed: one hour unless given.
  const end = allDay ? fromUtc(new Date(asUtc(v.end ?? v.start).getTime() + 86_400_000), false) : (v.end ?? fromUtc(new Date(asUtc(v.start).getTime() + 3_600_000), true));
  if (asUtc(end) <= asUtc(v.start)) throw new z.ZodError([{ code: "custom", path: ["end"], message: "end must be after start" }]);
  if (asUtc(end).getTime() - asUtc(v.start).getTime() > 31 * 86_400_000) throw new z.ZodError([{ code: "custom", path: ["end"], message: "at most 31 days long" }]);
  return { ...v, allDay, end, timeZone: v.timeZone ?? defaultTimeZone, attendees: v.attendees ? [...new Set(v.attendees)] : undefined };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 3 Nov 2026, 14:00–15:00 (Europe/Sofia)", or "Tue 3 Nov 2026 (all day)". */
export function describeWhen(e: { start: string; end: string; allDay: boolean; timeZone: string }): string {
  // Formatted by hand: the text is part of the approval hash, so it must not vary with the runtime's locale data.
  const day = (v: string) => {
    const d = asUtc(v);
    return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  if (e.allDay) {
    const last = fromUtc(new Date(asUtc(e.end).getTime() - 86_400_000), false);
    return last === e.start ? `${day(e.start)} (all day)` : `${day(e.start)} – ${day(last)} (all day)`;
  }
  const time = (v: string) => v.slice(11, 16);
  return e.start.slice(0, 10) === e.end.slice(0, 10)
    ? `${day(e.start)}, ${time(e.start)}–${time(e.end)} (${e.timeZone})`
    : `${day(e.start)} ${time(e.start)} – ${day(e.end)} ${time(e.end)} (${e.timeZone})`;
}

/**
 * Creating an event on the signed-in user's own Google Calendar. A write: the
 * model only proposes it, the user approves the exact event on the card, and
 * the worker creates it once. The calendar owner is the proposing user (trusted
 * context), never a model argument.
 */
export function registerCalendarCreateCapability(registry: CapabilityRegistry, connector: Connector, opts: { timeZone: string }): void {
  registry.register({
    definition: {
      id: "calendar.event.create",
      version: "1.0.0",
      kind: "write",
      description:
        `PROPOSE creating an event on the user's own Google Calendar. This never executes directly: it creates a proposal the user must approve. ` +
        `Only use when the user explicitly asks to create, schedule or book an event or meeting. start is "YYYY-MM-DD" for an all-day event or "YYYY-MM-DDTHH:MM" (24-hour, local time); ` +
        `end is optional (timed events default to one hour). Times are in ${opts.timeZone} unless the user names another time zone (then pass timeZone). ` +
        `If the user gave no date, ask for it instead of guessing. Add attendees only when the user names their email addresses.`,
      input: CreateEventInput,
      requiredGroups: [],
      timeoutMs: 20_000,
      connectorId: connector.id,
    },
    healthy: async () => {
      try {
        return (await connector.tools()).some((t) => t.name === "event_create" && t.enabled);
      } catch {
        return false;
      }
    },
    write: {
      connectorId: connector.id,
      tool: "event_create",
      describe: (input) => {
        const e = normalizeEvent(input, opts.timeZone);
        return {
          operation: `Create event "${e.title}" on ${describeWhen(e)}${e.location ? ` at ${e.location}` : ""}`,
          destination: "Your Google Calendar (primary)",
          risk: e.attendees?.length
            ? `Google emails an invitation to ${e.attendees.length === 1 ? "1 attendee" : `${e.attendees.length} attendees`}: ${e.attendees.join(", ")}. The assistant can't change or delete the event afterwards; you can, in Google Calendar.`
            : "Only on your own calendar; nobody is invited. The assistant can't change or delete it afterwards; you can, in Google Calendar.",
        };
      },
      toConnectorArgs: (input, meta): Record<string, unknown> => {
        const e = normalizeEvent(input, opts.timeZone);
        const args: CreateEventArgs = {
          owner: meta.principalId,
          // Google event ids are base32hex (a-v, 0-9): a hex form of the proposal's key qualifies.
          eventId: `pa${meta.idempotencyKey.replace(/-/g, "").toLowerCase()}`,
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          timeZone: e.timeZone,
          ...(e.description ? { description: e.description } : {}),
          ...(e.location ? { location: e.location } : {}),
          ...(e.attendees?.length ? { attendees: e.attendees } : {}),
        };
        return { ...args };
      },
      reconcile: async (read, args) => {
        const r = (await read("event_get", { owner: args.owner, eventId: args.eventId })) as { found?: boolean; eventId?: string; htmlLink?: string };
        return r?.found ? { eventId: r.eventId, htmlLink: r.htmlLink, reconciled: true } : undefined;
      },
      receipt: (result) => {
        const r = result as { eventId?: string; htmlLink?: string; created?: boolean };
        return { eventId: r?.eventId, htmlLink: r?.htmlLink, created: r?.created };
      },
    },
  });
}
