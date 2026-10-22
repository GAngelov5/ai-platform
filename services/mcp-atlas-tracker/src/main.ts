import { CalendarStore } from "./calendar.js";
import { createTrackerHttpServer } from "./server.js";
import { TrackerStore } from "./store.js";

const token = process.env.TRACKER_TOKEN;
if (!token || token.length < 16) {
  console.error("TRACKER_TOKEN (>= 16 chars) is required");
  process.exit(78);
}
const port = Number(process.env.TRACKER_PORT ?? process.env.PORT ?? 8080);
const store = await new TrackerStore(process.env.TRACKER_DATA_FILE ?? "/data/tracker.json").load();
// Optional synthetic calendar endpoint (/calendar/mcp) with its own token.
const calendarToken = process.env.CALENDAR_TOKEN;
if (calendarToken !== undefined && calendarToken.length < 16) {
  console.error("CALENDAR_TOKEN must be >= 16 chars");
  process.exit(78);
}
const calendar = calendarToken ? { store: new CalendarStore(), token: calendarToken } : undefined;
const testHooks = process.env.TRACKER_TEST_HOOKS === "1";
createTrackerHttpServer({ store, token, calendar, testHooks }).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", msg: "atlas-tracker MCP server listening", port, calendar: !!calendar, testHooks }));
});
